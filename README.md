# Intent Translator: English to German

An AI-powered translation application that goes beyond word-for-word translation. It analyzes the **communicative intent**, **emotion**, and **cultural context** to translate English into culturally accurate German, adjusting the register appropriately.

## Key Features

- **Intent & Emotion Detection:** Understands *why* you are saying something (e.g., politely complaining, asking for help) and the emotion behind it.
- **Cultural Accuracy:** Uses Qdrant vector database to retrieve German cultural norms (e.g., directness vs. US indirectness, formal Sie vs. informal Du) and applies them to the translation.
- **Live Context Crawling:** Automatically uses Firecrawl to find live, relevant German website context for difficult phrases or nuanced topics.
- **Local Inference:** Runs entirely locally using `llama-cpp-python` (or `ollama`), ensuring privacy and speed.
- **Interactive UI:** Built with Vite and React, featuring an "Insights Drawer" that explicitly explains the detected emotion, intent, and precisely *why* the translation adapted to specific cultural norms.

## Tech Stack

- **Backend:** FastAPI, `llama-cpp-python` (Llama 3.2 1B Instruct Q4_K_M GGUF), Sentence-Transformers (all-MiniLM-L6-v2)
- **Database:** Qdrant (Docker) for Retrieval-Augmented Generation (RAG)
- **Frontend:** React, Vite
- **External APIs:** Firecrawl (for live context augmentation)

---

## Prerequisites

1.  **Docker** (for Qdrant)
2.  **Python 3.10+**
3.  **Node.js 18+**
4.  **A local LLM**: Download `Llama-3.2-1B-Instruct-Q4_K_M.gguf` (or similar) into a `models/` directory.

## Setup Instructions

### 1. Database (Qdrant)

Start the Qdrant vector database via Docker:

```bash
docker run -p 6333:6333 -p 6334:6334 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
```

### 2. Backend (FastAPI)

```bash
cd backend
python -m venv venv
# Windows:
.\venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

pip install -r requirements.txt
```

Create a `.env` file in the `backend/` directory based on `.env.example`:

```env
# backend/.env
LLAMA_MODEL_PATH=../models/Llama-3.2-1B-Instruct-Q4_K_M.gguf
FIRECRAWL_API_KEY=your_api_key_here
```

Start the backend:
```bash
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Frontend (React/Vite)

Open a new terminal:
```bash
cd frontend
npm install
npm run dev
```

The application will be running at `http://localhost:5173`.

---

## Usage

1.  **Index the Knowledge Base:** When you first start the app, click the **"Index KB"** button in the top right. This populates Qdrant with the core cultural and intent patterns from `data/knowledge_base/` so the model understands German norms.
2.  **Translate!**: Type an English sentence. The system will detect your intent, emotion, pull live context from Firecrawl, and return a culturally-adjusted German translation along with explanations.
