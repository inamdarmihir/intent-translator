#!/bin/bash
# Dev mode: backend on :8000, frontend dev server on :5173 with HMR

echo "Starting backend…"
cd backend
[ ! -d venv ] && python3 -m venv venv
source venv/bin/activate
pip install -q -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
cd ..

echo "Starting frontend dev server…"
cd frontend
[ ! -d node_modules ] && npm install
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "Backend:  http://localhost:8000"
echo "Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
