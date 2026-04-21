"""
main.py — Intent Translator API

Features added in this version:
  • Firecrawl quota guard  (quota.py)  — hard monthly cap, auto-resets
  • Query-triggered crawl             — crawl fires on translate if context is thin
  • Ollama-first inference            — local Llama, falls back to Claude
  • Local embeddings                  — sentence-transformers, zero API cost
"""

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=True)

import quota as quota_mod
import inference as inf

# ── Constants ────────────────────────────────────────────────────────────────
INTENT_COLLECTION  = "intent_patterns"
CULTURE_COLLECTION = "cultural_context"
CRAWLED_COLLECTION = "crawled_documents"
DATA_DIR = Path(__file__).parent.parent / "data" / "knowledge_base"
VECTOR_DIM = 384

# Min cosine-score chunks in CRAWLED before we bother crawling on translate
CRAWL_ON_QUERY_THRESHOLD = int(os.getenv("CRAWL_ON_QUERY_THRESHOLD", "2"))
# Pages to fetch per auto-crawl (keeps quota low)
AUTO_CRAWL_PAGES = int(os.getenv("AUTO_CRAWL_PAGES", "3"))

_crawl_sessions: dict[str, dict] = {}

# ── Qdrant singleton ─────────────────────────────────────────────────────────
_qdrant = None

def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        host = os.getenv("QDRANT_HOST", "localhost")
        port = int(os.getenv("QDRANT_PORT", "6333"))
        _qdrant = QdrantClient(host=host, port=port)
    return _qdrant


# ── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Intent Translator API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic models ──────────────────────────────────────────────────────────
class TranslateRequest(BaseModel):
    text: str
    source_lang: str = "en"
    target_lang: str = "de"
    register: Optional[str] = None
    auto_crawl: bool = True   # trigger crawl if context is thin


class TranslateResponse(BaseModel):
    translation: str
    intent_detected: str
    emotion_detected: str
    cultural_notes: list[str]
    what_changed: str
    retrieved_patterns: list[dict]
    crawled_chunks_used: list[dict]
    register_used: str
    engine_used: str
    auto_crawl_triggered: bool
    quota: dict


class IndexStatus(BaseModel):
    intent_count: int
    culture_count: int
    crawled_count: int
    status: str
    quota: dict
    inference: dict


class CrawlRequest(BaseModel):
    url: str
    max_pages: int = 10


class CrawlStatus(BaseModel):
    crawl_id: str
    status: str
    pages_crawled: int
    chunks_indexed: int
    current_url: str
    log: list[str]
    quota: dict


class QuotaUpdateRequest(BaseModel):
    cap: int


# ── Text chunking ────────────────────────────────────────────────────────────
def chunk_text(text: str, chunk_size: int = 400, overlap: int = 80) -> list[str]:
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return []
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for sentence in sentences:
        slen = len(sentence)
        if current_len + slen > chunk_size and current:
            chunks.append(' '.join(current))
            tail: list[str] = []
            acc = 0
            for s in reversed(current):
                acc += len(s)
                tail.insert(0, s)
                if acc >= overlap:
                    break
            current = tail
            current_len = sum(len(s) for s in current)
        current.append(sentence)
        current_len += slen
    if current:
        chunks.append(' '.join(current))
    return [c for c in chunks if len(c) > 60]


def url_to_id(url: str, chunk_idx: int) -> int:
    return int(hashlib.md5(f"{url}::{chunk_idx}".encode()).hexdigest()[:12], 16)


# ── Qdrant helpers ───────────────────────────────────────────────────────────
def ensure_collection(name: str) -> None:
    from qdrant_client.models import Distance, VectorParams
    client = get_qdrant()
    if not client.collection_exists(name):
        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
        )


def upsert_chunks(chunks: list[str], url: str, title: str, source_lang: str) -> int:
    from qdrant_client.models import PointStruct
    if not chunks:
        return 0
    ensure_collection(CRAWLED_COLLECTION)
    vectors = inf.embed(chunks)
    points = [
        PointStruct(
            id=url_to_id(url, i),
            vector=vectors[i],
            payload={"text": chunks[i], "url": url, "title": title,
                     "source_lang": source_lang, "chunk_index": i,
                     "ingested_at": int(time.time())},
        )
        for i in range(len(chunks))
    ]
    get_qdrant().upsert(collection_name=CRAWLED_COLLECTION, points=points)
    return len(points)


def retrieve_from(collection: str, query: str, top_k: int) -> list[dict]:
    client = get_qdrant()
    if not client.collection_exists(collection):
        return []
    vector = inf.embed_one(query)
    results = client.search(collection_name=collection, query_vector=vector, limit=top_k)
    return [r.payload for r in results]


def retrieve_with_scores(collection: str, query: str, top_k: int) -> list[tuple[dict, float]]:
    client = get_qdrant()
    if not client.collection_exists(collection):
        return []
    vector = inf.embed_one(query)
    results = client.search(collection_name=collection, query_vector=vector,
                            limit=top_k, with_payload=True)
    return [(r.payload, r.score) for r in results]


# ── Static KB indexing ───────────────────────────────────────────────────────
def build_intent_text(p: dict) -> str:
    return (f"{p['intent_label']}. {p['en_expression']} "
            f"Register: {p['register']}. Tone: {p['emotional_tone']}. "
            f"Tags: {', '.join(p['tags'])}.")


def build_culture_text(e: dict) -> str:
    return f"{e['title']}. {e['description']}"


def index_knowledge_base() -> dict:
    from qdrant_client.models import Distance, VectorParams, PointStruct
    client = get_qdrant()

    with open(DATA_DIR / "intent_patterns.json") as f:
        intent_patterns = json.load(f)
    with open(DATA_DIR / "cultural_context.json") as f:
        cultural_context = json.load(f)

    for name in [INTENT_COLLECTION, CULTURE_COLLECTION]:
        if client.collection_exists(name):
            client.delete_collection(name)
        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
        )

    iv = inf.embed([build_intent_text(p) for p in intent_patterns])
    client.upsert(INTENT_COLLECTION,
                  [PointStruct(id=i, vector=iv[i], payload=intent_patterns[i])
                   for i in range(len(intent_patterns))])

    cv = inf.embed([build_culture_text(e) for e in cultural_context])
    client.upsert(CULTURE_COLLECTION,
                  [PointStruct(id=i, vector=cv[i], payload=cultural_context[i])
                   for i in range(len(cultural_context))])

    crawled_count = 0
    if client.collection_exists(CRAWLED_COLLECTION):
        crawled_count = client.get_collection(CRAWLED_COLLECTION).points_count

    return {"intent_count": len(intent_patterns), "culture_count": len(cultural_context),
            "crawled_count": crawled_count, "status": "indexed",
            "quota": quota_mod.get_quota(), "inference": inf.get_inference_status()}


# ── Translation ──────────────────────────────────────────────────────────────
def translate_with_intent(
    text: str,
    intent_patterns: list[dict],
    cultural_context: list[dict],
    crawled_chunks: list[dict],
    register: Optional[str],
) -> tuple[dict, str]:
    """Returns (result_dict, engine_used_string). Raises ValueError on bad LLM output."""
    crawled_block = ""
    if crawled_chunks:
        snippets = [f"[{c.get('title', 'Web')}] {c['text'][:300]}" for c in crawled_chunks]
        crawled_block = (
            "\nLIVE-CRAWLED CONTEXT (relevant German-language web content):\n"
            + json.dumps(snippets, ensure_ascii=False, indent=2)
        )

    register_hint = f"Register target: {register}." if register else ""

    system = (
        "You are a senior EN→DE translator with expertise in pragmatics, communicative intent, "
        "and cross-cultural communication. You translate what the speaker MEANS and what will "
        "LAND CORRECTLY in German culture — not just the words. "
        "Output ONLY a single raw JSON object. No markdown fences, no commentary, no extra text."
    )

    user = f"""Analyse and translate the English text below into German.

ENGLISH TEXT:
\"{text}\"

{register_hint}

INTENT PATTERNS retrieved from knowledge base:
{json.dumps(intent_patterns, indent=2, ensure_ascii=False)}

CULTURAL CONTEXT retrieved from knowledge base:
{json.dumps(cultural_context, indent=2, ensure_ascii=False)}
{crawled_block}

Work through these steps, then output the JSON:

Step 1 — EMOTION: What emotion is the speaker expressing? (e.g. polite frustration, helpfulness-seeking, urgency, formal respect, apologetic, assertive)
Step 2 — INTENT: What is the communicative goal? (e.g. requesting help, lodging a complaint, making a formal apology, expressing gratitude)
Step 3 — REGISTER: What register fits this context and the German recipient? (formal / semi-formal / informal)
Step 4 — TRANSLATE: Write a German translation that achieves the same communicative effect. Apply German cultural norms: directness, Sie/du choice, removing English hedging, appropriate formality.
Step 5 — CULTURAL NOTES: Write 2 specific sentences explaining what you changed and why, grounded in German cultural norms. Each note must be about THIS specific translation.
Step 6 — WHAT CHANGED: One or two sentences summarising the key cultural and register adjustments.

Output ONLY this JSON with all fields filled from your analysis above:
{{
  "translation": "",
  "intent_detected": "",
  "emotion_detected": "",
  "cultural_notes": ["", ""],
  "what_changed": "",
  "register_used": ""
}}"""

    raw, engine = inf.generate(system, user)
    result = inf.parse_json_response(raw)

    # ── Strict validation — no silent fallbacks ────────────────────────────
    required = {"translation", "intent_detected", "emotion_detected",
                "cultural_notes", "what_changed", "register_used"}
    missing = required - set(result.keys())
    if missing or not result.get("translation", "").strip():
        raise ValueError(
            f"LLM returned incomplete response. Missing fields: {missing or 'none'}. "
            f"Raw output (first 400 chars): {raw[:400]}"
        )

    return result, engine


# ── Query-triggered auto-crawl ───────────────────────────────────────────────
def _build_search_query(text: str) -> str:
    """Extract meaningful topic words for a targeted Firecrawl search."""
    # Pull substantive words (4+ chars) to form a focused query
    words = re.findall(r'\b[a-zA-Z]{4,}\b', text)
    topic = " ".join(words[:8])
    return f"{topic} German communication culture formal register"


def auto_crawl_for_query(text: str) -> tuple[int, str]:
    """
    Fire a targeted Firecrawl scrape for the query topic.
    Uses /v1/search endpoint (1 credit per result, not per page crawled).
    Returns (chunks_added, status_message).
    """
    import httpx as hx

    api_key = os.getenv("FIRECRAWL_API_KEY")
    if not api_key:
        return 0, "no_api_key"

    remaining = quota_mod.remaining_pages()
    if remaining < 2:
        return 0, "quota_exhausted"

    pages_to_fetch = min(AUTO_CRAWL_PAGES, remaining)
    search_query = _build_search_query(text)

    try:
        # Use Firecrawl /search — targeted, uses fewer credits than full crawl
        resp = hx.post(
            "https://api.firecrawl.dev/v1/search",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "query": search_query,
                "limit": pages_to_fetch,
                "lang": "de",
                "scrapeOptions": {"formats": ["markdown"], "onlyMainContent": True},
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("data") or []
    except Exception as e:
        return 0, f"crawl_error:{e}"

    total_chunks = 0
    pages_consumed = 0
    ensure_collection(CRAWLED_COLLECTION)

    for page in results:
        md = page.get("markdown") or page.get("content") or ""
        if not md or len(md) < 100:
            continue
        meta = page.get("metadata") or {}
        url = meta.get("sourceURL") or page.get("url", "unknown")
        title = meta.get("title") or url
        lang = meta.get("language") or "de"
        chunks = chunk_text(md)
        total_chunks += upsert_chunks(chunks, url, title, lang)
        pages_consumed += 1

    if pages_consumed > 0:
        try:
            quota_mod.consume(pages_consumed)
        except quota_mod.QuotaExhausted:
            pass   # consumed what we could

    return total_chunks, f"ok:{pages_consumed}_pages"


# ── SSE helper ───────────────────────────────────────────────────────────────
def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ── Manual Firecrawl crawl (streaming) ──────────────────────────────────────
def crawl_and_stream(crawl_id: str, url: str, max_pages: int):
    import httpx

    api_key = os.getenv("FIRECRAWL_API_KEY")
    if not api_key:
        yield sse("error", {"message": "FIRECRAWL_API_KEY not set in .env"})
        return

    # ── Quota pre-check ───────────────────────────────────────────────────
    remaining = quota_mod.remaining_pages()
    if remaining <= 0:
        q = quota_mod.get_quota()
        yield sse("error", {
            "message": f"Monthly quota exhausted ({q['pages_used']}/{q['cap']} pages used). Resets {q['month']}.",
            "quota": q,
        })
        return

    effective_max = min(max_pages, remaining)
    if effective_max < max_pages:
        yield sse("warn", {
            "message": f"Capping crawl to {effective_max} pages (quota: {remaining} remaining this month).",
            "quota": quota_mod.get_quota(),
        })

    session = _crawl_sessions[crawl_id]
    yield sse("status", {"message": f"Starting crawl of {url} (max {effective_max} pages)", "phase": "starting"})

    # ── Start Firecrawl job ───────────────────────────────────────────────
    try:
        resp = httpx.post(
            "https://api.firecrawl.dev/v1/crawl",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "url": url,
                "limit": effective_max,
                "scrapeOptions": {"formats": ["markdown"], "onlyMainContent": True},
            },
            timeout=30,
        )
        resp.raise_for_status()
        job = resp.json()
        job_id = job.get("id") or job.get("jobId")
        if not job_id:
            raise ValueError(f"No job ID: {job}")
    except Exception as e:
        session["status"] = "error"
        yield sse("error", {"message": f"Failed to start crawl: {e}"})
        return

    session["job_id"] = job_id
    yield sse("status", {"message": f"Job queued (id={job_id})", "phase": "crawling", "job_id": job_id})

    # ── Poll + stream ─────────────────────────────────────────────────────
    seen_urls: set[str] = set()
    total_chunks = 0
    pages_consumed = 0
    ensure_collection(CRAWLED_COLLECTION)

    for _ in range(120):
        time.sleep(3)

        try:
            poll = httpx.get(
                f"https://api.firecrawl.dev/v1/crawl/{job_id}",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=20,
            )
            poll.raise_for_status()
            data = poll.json()
        except Exception as e:
            yield sse("warn", {"message": f"Poll error: {e}"})
            continue

        crawl_status = data.get("status", "")

        for page in (data.get("data") or []):
            meta = page.get("metadata") or {}
            page_url = meta.get("sourceURL") or page.get("url", "")
            if not page_url or page_url in seen_urls:
                continue
            seen_urls.add(page_url)

            md = page.get("markdown") or page.get("content") or ""
            title = meta.get("title") or page_url
            lang = meta.get("language") or "de"

            if not md or len(md) < 100:
                yield sse("skip", {"url": page_url, "reason": "too short"})
                continue

            # Quota check per page
            if not quota_mod.can_crawl(1):
                q = quota_mod.get_quota()
                yield sse("quota_stop", {
                    "message": f"Quota reached mid-crawl ({q['pages_used']}/{q['cap']}). Stopping.",
                    "quota": q,
                })
                session["status"] = "done"
                return

            chunks = chunk_text(md)
            count = upsert_chunks(chunks, page_url, title, lang)
            total_chunks += count
            pages_consumed += 1

            try:
                quota_mod.consume(1)
            except quota_mod.QuotaExhausted:
                pass

            session["pages_crawled"] += 1
            session["chunks_indexed"] += count
            session["current_url"] = page_url

            msg = f"✓ [{session['pages_crawled']}] {title[:55]} → {count} chunks"
            session["log"].append(msg)

            yield sse("page", {
                "url": page_url,
                "title": title,
                "chunks": count,
                "total_chunks": total_chunks,
                "pages_crawled": session["pages_crawled"],
                "message": msg,
                "quota": quota_mod.get_quota(),
            })

        if crawl_status == "completed":
            session["status"] = "done"
            yield sse("done", {
                "message": f"Done. {session['pages_crawled']} pages · {total_chunks} chunks.",
                "pages_crawled": session["pages_crawled"],
                "chunks_indexed": total_chunks,
                "quota": quota_mod.get_quota(),
            })
            return

        if crawl_status in ("failed", "cancelled"):
            session["status"] = "error"
            yield sse("error", {"message": f"Crawl ended: {crawl_status}"})
            return

        yield sse("heartbeat", {
            "pages_so_far": session["pages_crawled"],
            "chunks_so_far": total_chunks,
            "crawl_status": crawl_status,
            "quota": quota_mod.get_quota(),
        })

    session["status"] = "error"
    yield sse("error", {"message": "Crawl timed out."})


# ── Routes ───────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "inference": inf.get_inference_status(), "quota": quota_mod.get_quota()}


@app.post("/index", response_model=IndexStatus)
def index_endpoint():
    return IndexStatus(**index_knowledge_base())


@app.get("/index/status", response_model=IndexStatus)
def index_status():
    client = get_qdrant()
    intent_count = culture_count = crawled_count = 0
    status = "not_indexed"
    if client.collection_exists(INTENT_COLLECTION):
        intent_count = client.get_collection(INTENT_COLLECTION).points_count
        status = "indexed"
    if client.collection_exists(CULTURE_COLLECTION):
        culture_count = client.get_collection(CULTURE_COLLECTION).points_count
    if client.collection_exists(CRAWLED_COLLECTION):
        crawled_count = client.get_collection(CRAWLED_COLLECTION).points_count
    return IndexStatus(
        intent_count=intent_count, culture_count=culture_count,
        crawled_count=crawled_count, status=status,
        quota=quota_mod.get_quota(), inference=inf.get_inference_status(),
    )


@app.get("/quota")
def get_quota():
    return quota_mod.get_quota()


@app.post("/quota/cap")
def update_quota_cap(req: QuotaUpdateRequest):
    if req.cap < 1 or req.cap > 500:
        raise HTTPException(status_code=400, detail="Cap must be between 1 and 500")
    return quota_mod.set_cap(req.cap)


@app.post("/quota/reset")
def reset_quota():
    return quota_mod.reset_quota()


@app.get("/inference/status")
def inference_status():
    return inf.get_inference_status()


@app.post("/inference/pull-model")
def pull_model():
    """Pull the Ollama model (secondary engine) if not already available."""
    if not inf.ollama_available():
        return {"success": False, "message": "Ollama is not running. Start with: ollama serve"}
    if inf.ollama_model_pulled():
        return {"success": True, "message": f"{inf.OLLAMA_MODEL} already pulled"}
    success = inf.ollama_pull_model()
    return {"success": success, "message": f"Pulled {inf.OLLAMA_MODEL}" if success else "Pull failed"}


@app.post("/crawl/start")
def crawl_start(req: CrawlRequest):
    q = quota_mod.get_quota()
    if q["exhausted"]:
        raise HTTPException(status_code=429, detail=f"Monthly quota exhausted ({q['pages_used']}/{q['cap']}). Resets next month.")
    crawl_id = str(uuid.uuid4())[:8]
    _crawl_sessions[crawl_id] = {
        "status": "running", "pages_crawled": 0, "chunks_indexed": 0,
        "current_url": req.url, "log": [], "job_id": None,
    }
    return {"crawl_id": crawl_id, "url": req.url, "max_pages": req.max_pages, "quota": q}


@app.get("/crawl/stream/{crawl_id}")
def crawl_stream(crawl_id: str, url: str, max_pages: int = 10):
    if crawl_id not in _crawl_sessions:
        _crawl_sessions[crawl_id] = {
            "status": "running", "pages_crawled": 0, "chunks_indexed": 0,
            "current_url": url, "log": [], "job_id": None,
        }
    return StreamingResponse(
        crawl_and_stream(crawl_id, url, max_pages),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/crawl/status/{crawl_id}", response_model=CrawlStatus)
def get_crawl_status(crawl_id: str):
    session = _crawl_sessions.get(crawl_id)
    if not session:
        raise HTTPException(status_code=404, detail="Crawl session not found")
    return CrawlStatus(
        crawl_id=crawl_id, status=session["status"],
        pages_crawled=session["pages_crawled"], chunks_indexed=session["chunks_indexed"],
        current_url=session["current_url"], log=session["log"][-30:],
        quota=quota_mod.get_quota(),
    )


@app.delete("/crawl/documents")
def clear_crawled():
    client = get_qdrant()
    if client.collection_exists(CRAWLED_COLLECTION):
        client.delete_collection(CRAWLED_COLLECTION)
    return {"cleared": True}


@app.post("/translate", response_model=TranslateResponse)
def translate_endpoint(req: TranslateRequest):
    client = get_qdrant()
    if not client.collection_exists(INTENT_COLLECTION):
        raise HTTPException(status_code=400, detail="Knowledge base not indexed. POST /index first.")

    intent_patterns = retrieve_from(INTENT_COLLECTION, req.text, top_k=3)
    cultural_ctx = retrieve_from(CULTURE_COLLECTION, req.text, top_k=2)

    # ── Always-on Firecrawl: check quality first, crawl if needed ────────
    auto_crawl_triggered = False
    if req.auto_crawl and os.getenv("FIRECRAWL_API_KEY"):
        # Score-based quality check: only use chunks that are genuinely relevant
        scored = retrieve_with_scores(CRAWLED_COLLECTION, req.text, top_k=5)
        high_quality = [c for c, s in scored if s >= 0.55]
        if len(high_quality) < 3 and quota_mod.can_crawl(1):
            # Not enough relevant context — always crawl for this query
            added, _ = auto_crawl_for_query(req.text)
            if added > 0:
                auto_crawl_triggered = True
        crawled_chunks = retrieve_from(CRAWLED_COLLECTION, req.text, top_k=5)
    else:
        crawled_chunks = retrieve_from(CRAWLED_COLLECTION, req.text, top_k=5)

    try:
        result, engine = translate_with_intent(
            text=req.text,
            intent_patterns=intent_patterns,
            cultural_context=cultural_ctx,
            crawled_chunks=crawled_chunks,
            register=req.register,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    return TranslateResponse(
        translation=result["translation"],
        intent_detected=result["intent_detected"],
        emotion_detected=result["emotion_detected"],
        cultural_notes=result["cultural_notes"],
        what_changed=result["what_changed"],
        retrieved_patterns=intent_patterns,
        crawled_chunks_used=crawled_chunks,
        register_used=result["register_used"],
        engine_used=engine,
        auto_crawl_triggered=auto_crawl_triggered,
        quota=quota_mod.get_quota(),
    )


class SettingsData(BaseModel):
    llama_model_path: str
    firecrawl_api_key: str

def _load_env_dict():
    env_path = Path(__file__).parent / ".env"
    res = {}
    if env_path.exists():
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    res[k.strip()] = v.strip()
    return res

def _save_env_dict(d: dict):
    env_path = Path(__file__).parent / ".env"
    with open(env_path, "w") as f:
        for k, v in d.items():
            f.write(f"{k}={v}\n")

@app.get("/settings", response_model=SettingsData)
def get_settings():
    return SettingsData(
        llama_model_path=os.getenv("LLAMA_MODEL_PATH", ""),
        firecrawl_api_key=os.getenv("FIRECRAWL_API_KEY", "")
    )

@app.post("/settings")
def update_settings(data: SettingsData):
    d = _load_env_dict()
    if data.llama_model_path is not None:
        d["LLAMA_MODEL_PATH"] = data.llama_model_path
        os.environ["LLAMA_MODEL_PATH"] = data.llama_model_path
    if data.firecrawl_api_key is not None:
        d["FIRECRAWL_API_KEY"] = data.firecrawl_api_key
        os.environ["FIRECRAWL_API_KEY"] = data.firecrawl_api_key
        
    _save_env_dict(d)
    inf.reinitialize()
    return {"status": "success"}


# ── Static frontend ──────────────────────────────────────────────────────────
frontend_dir = Path(__file__).parent.parent / "frontend" / "dist"

if frontend_dir.exists():
    app.mount("/assets", StaticFiles(directory=frontend_dir / "assets"), name="assets")

    @app.get("/")
    def serve_index():
        return FileResponse(frontend_dir / "index.html")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        file_path = frontend_dir / full_path
        return FileResponse(file_path if file_path.exists() else frontend_dir / "index.html")
