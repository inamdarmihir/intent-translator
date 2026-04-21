<div align="center">

# 🇩🇪 Intent Translator: English → German

**AI-powered translation that goes beyond words — analyzing communicative intent, emotion, and cultural context to produce culturally accurate German.**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Backend-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Qdrant](https://img.shields.io/badge/Qdrant-Vector%20DB-DC244C?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTV6TTIgMTdsOSA1IDktNXYtNWwtOSA1LTktNXoiLz48L3N2Zz4=&logoColor=white)](https://qdrant.tech/)
[![Docker](https://img.shields.io/badge/Docker-Qdrant-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![Firecrawl](https://img.shields.io/badge/Firecrawl-Live%20Context-FF6B35?style=flat-square)](https://www.firecrawl.dev/)
[![License](https://img.shields.io/badge/License-MIT-6366f1?style=flat-square)](LICENSE)

<br/>

*Runs entirely locally — your text never leaves your machine.*

</div>

---

## What Makes This Different

Most translation tools map words to words. Intent Translator maps *meaning to meaning* — understanding the social and cultural layer of language before producing output.

| Feature | Description |
|---|---|
| 🧠 **Intent & Emotion Detection** | Understands *why* you're saying something (e.g., politely complaining, asking for help) and the emotion behind it |
| 🇩🇪 **Cultural Accuracy** | Retrieves German cultural norms from a Qdrant knowledge base — directness vs. US indirectness, formal `Sie` vs. informal `Du`, and more |
| 🌐 **Live Context Crawling** | Uses Firecrawl to fetch live German website context for difficult phrases or nuanced topics |
| 🔒 **Local Inference** | Runs fully locally via `llama-cpp-python` — no cloud API calls, full privacy |
| 💡 **Insights Drawer** | Interactive UI that explains the detected emotion, intent, and precisely *why* the translation adapted to specific cultural norms |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI |
| LLM inference | `llama-cpp-python` — Llama 3.2 1B Instruct Q4_K_M GGUF |
| Embeddings | Sentence-Transformers (`all-MiniLM-L6-v2`) |
| Vector database | Qdrant (Docker) |
| Frontend | React + Vite |
| Live context | Firecrawl API |

---

## Prerequisites

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Required-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)

- **Docker** — for running Qdrant
- **Python 3.10+**
- **Node.js 18+**
- **A local LLM** — download `Llama-3.2-1B-Instruct-Q4_K_M.gguf` (or similar) into a `models/` directory
- **Firecrawl API key** — for live context augmentation ([get one free](https://www.firecrawl.dev/))

---

## Setup

### 1. Database — Qdrant

Start the Qdrant vector database via Docker:

```bash
docker run -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

### 2. Backend — FastAPI

```bash
cd backend
python -m venv venv

# Windows
.\venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

Create a `.env` file in the `backend/` directory:

```env
LLAMA_MODEL_PATH=../models/Llama-3.2-1B-Instruct-Q4_K_M.gguf
FIRECRAWL_API_KEY=your_api_key_here
```

Start the backend:

```bash
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Frontend — React / Vite

Open a new terminal:

```bash
cd frontend
npm install
npm run dev
```

The app is now running at **http://localhost:5173**

---

## Usage

**1. Index the knowledge base**

On first launch, click the **"Index KB"** button in the top right. This populates Qdrant with core cultural and intent patterns from `data/knowledge_base/` so the model understands German norms.

**2. Translate**

Type any English sentence. The system will detect your intent and emotion, pull live context via Firecrawl, and return a culturally-adjusted German translation with a full explanation in the Insights Drawer.

---

<div align="center">

Built with ❤️ using [Qdrant](https://qdrant.tech/) · [FastAPI](https://fastapi.tiangolo.com/) · [Firecrawl](https://www.firecrawl.dev/) · [llama-cpp-python](https://github.com/abetlen/llama-cpp-python)

</div>
