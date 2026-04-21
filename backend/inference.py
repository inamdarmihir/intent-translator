"""
inference.py — Fully local inference. No cloud API.

LLM Tier 1: llama.cpp via llama-cpp-python
            Supports GGUF models including BitNet quantized variants.
            Set LLAMA_MODEL_PATH=/path/to/model.gguf in backend/.env

LLM Tier 2: Ollama (wraps llama.cpp under the hood)
            Run: ollama serve && ollama pull llama3.2

Raises RuntimeError if neither is available — no silent cloud fallback.

Embedding: sentence-transformers all-MiniLM-L6-v2 (always local, ~22ms)
"""

import json
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=True)

# ── Embedding (always local, no API key) ─────────────────────────────────────
_embedder = None
EMBED_MODEL = "all-MiniLM-L6-v2"


def get_embedder():
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer
        _embedder = SentenceTransformer(EMBED_MODEL)
    return _embedder


def embed(texts: list[str]) -> list[list[float]]:
    return get_embedder().encode(texts).tolist()


def embed_one(text: str) -> list[float]:
    return embed([text])[0]


# ── llama.cpp via llama-cpp-python ────────────────────────────────────────────
# Supports GGUF models including BitNet b1.58 quantized weights.
# BitNet models use the same GGUF container — llama.cpp handles 1-bit weights
# natively when compiled with -DLLAMA_BITNET=ON or via the IQ1_S quantization.
LLAMA_MODEL_PATH = os.getenv("LLAMA_MODEL_PATH", "")
LLAMA_N_CTX = int(os.getenv("LLAMA_N_CTX", "4096"))
LLAMA_N_GPU_LAYERS = int(os.getenv("LLAMA_N_GPU_LAYERS", "0"))  # 0 = CPU-only
_llama_instance = None
_llama_loaded_path: str = ""


def _load_llama():
    global _llama_instance, _llama_loaded_path
    path = os.getenv("LLAMA_MODEL_PATH", "")
    if _llama_instance is not None and _llama_loaded_path == path:
        return _llama_instance
    if not path or not Path(path).exists():
        return None
    try:
        from llama_cpp import Llama
        _llama_instance = Llama(
            model_path=path,
            n_ctx=LLAMA_N_CTX,
            n_gpu_layers=LLAMA_N_GPU_LAYERS,
            verbose=False,
        )
        _llama_loaded_path = path
        return _llama_instance
    except Exception:
        return None


def llama_cpp_available() -> bool:
    try:
        from llama_cpp import Llama  # noqa: F401
        path = os.getenv("LLAMA_MODEL_PATH", "")
        return bool(path and Path(path).exists())
    except ImportError:
        return False


def llama_cpp_generate(system: str, user: str) -> str:
    llm = _load_llama()
    if llm is None:
        raise RuntimeError("llama.cpp model not loaded")
    output = llm.create_chat_completion(
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=1024,
        temperature=0.1,
    )
    return output["choices"][0]["message"]["content"]


# ── Ollama (secondary, wraps llama.cpp) ──────────────────────────────────────
OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
OLLAMA_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT", "120"))


def ollama_available() -> bool:
    try:
        r = httpx.get(f"{OLLAMA_BASE}/api/tags", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def ollama_model_pulled() -> bool:
    try:
        r = httpx.get(f"{OLLAMA_BASE}/api/tags", timeout=3)
        models = r.json().get("models", [])
        pulled = [m.get("name", "").split(":")[0] for m in models]
        return OLLAMA_MODEL.split(":")[0] in pulled
    except Exception:
        return False


def ollama_generate(system: str, user: str) -> str:
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "options": {"temperature": 0.1, "num_predict": 1024},
    }
    r = httpx.post(f"{OLLAMA_BASE}/api/chat", json=payload, timeout=OLLAMA_TIMEOUT)
    r.raise_for_status()
    return r.json()["message"]["content"]


def ollama_pull_model() -> bool:
    try:
        r = httpx.post(
            f"{OLLAMA_BASE}/api/pull",
            json={"name": OLLAMA_MODEL, "stream": False},
            timeout=300,
        )
        return r.status_code == 200
    except Exception:
        return False


# ── Unified generate — no cloud fallback ─────────────────────────────────────
def generate(system: str, user: str) -> tuple[str, str]:
    """
    Route: llama.cpp first → Ollama second → error (no cloud fallback).
    Returns (raw_text, engine_label).
    """
    if llama_cpp_available():
        try:
            t0 = time.monotonic()
            raw = llama_cpp_generate(system, user)
            ms = int((time.monotonic() - t0) * 1000)
            name = Path(os.getenv("LLAMA_MODEL_PATH", "")).stem
            return raw, f"llama.cpp:{name} ({ms}ms)"
        except Exception:
            pass

    if ollama_available() and ollama_model_pulled():
        try:
            t0 = time.monotonic()
            raw = ollama_generate(system, user)
            ms = int((time.monotonic() - t0) * 1000)
            return raw, f"ollama:{OLLAMA_MODEL} ({ms}ms)"
        except Exception:
            pass

    raise RuntimeError(
        "No local inference engine available. "
        "Option A: set LLAMA_MODEL_PATH=/path/to/model.gguf and pip install llama-cpp-python. "
        "Option B: run `ollama serve` then `ollama pull llama3.2`."
    )


def parse_json_response(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1] if len(parts) > 1 else text
        if text.startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}") + 1
    if start != -1 and end > start:
        text = text[start:end]
    return json.loads(text.strip())


def get_inference_status() -> dict:
    llama_ok = llama_cpp_available()
    ollama_ok = ollama_available()
    ollama_pulled = ollama_model_pulled() if ollama_ok else False
    path = os.getenv("LLAMA_MODEL_PATH", "")

    if llama_ok:
        active = f"llama.cpp:{Path(path).stem}"
    elif ollama_ok and ollama_pulled:
        active = f"ollama:{OLLAMA_MODEL}"
    else:
        active = "none"

    return {
        "llama_cpp_available": llama_ok,
        "llama_model_path": path or None,
        "llama_model_name": Path(path).stem if llama_ok else None,
        "ollama_available": ollama_ok,
        "ollama_model": OLLAMA_MODEL,
        "ollama_model_pulled": ollama_pulled,
        "ollama_base": OLLAMA_BASE,
        "active_engine": active,
        "embed_model": EMBED_MODEL,
        "embed_engine": "local (sentence-transformers)",
    }
