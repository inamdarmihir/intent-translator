#!/bin/bash
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Intent Translator · EN → DE"
echo "  Qdrant + Local Llama Pipeline"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check .env
if [ ! -f backend/.env ]; then
  echo ""
  echo "⚠️  No .env file found in backend/"
  echo "   Create backend/.env with:"
  echo "   LLAMA_MODEL_PATH=../models/Llama-3.2-1B-Instruct-Q4_K_M.gguf"
  echo "   FIRECRAWL_API_KEY=your_key_here (optional)"
  echo ""
  exit 1
fi

# Backend setup
echo ""
echo "▶ Setting up Python backend…"
cd backend

if [ ! -d "venv" ]; then
  python3 -m venv venv
  echo "  Created virtualenv"
fi

source venv/bin/activate
pip install -q -r requirements.txt
echo "  Dependencies installed"

# Start backend in background
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
echo "  Backend running (PID $BACKEND_PID)"

cd ..

# Frontend setup
echo ""
echo "▶ Setting up frontend…"
cd frontend

if [ ! -d "node_modules" ]; then
  npm install
fi

npm run build
echo "  Frontend built"

cd ..

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Running at http://localhost:8000"
echo ""
echo "  First step: click 'Index Knowledge Base'"
echo "  Then paste English text and translate."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Keep alive
wait $BACKEND_PID
