@echo off
echo ==========================================
echo   Intent Translator - EN to DE
echo   Qdrant + Local Llama Pipeline
echo ==========================================

if not exist backend\.env (
    echo.
    echo ERROR: No .env file found in backend\
    echo Create backend\.env with:
    echo LLAMA_MODEL_PATH=..\models\Llama-3.2-1B-Instruct-Q4_K_M.gguf
    echo FIRECRAWL_API_KEY=your_key_here (optional)
    echo.
    pause
    exit /b 1
)

echo.
echo Setting up Python backend...
cd backend

if not exist venv (
    python -m venv venv
)

call venv\Scripts\activate.bat
pip install -q -r requirements.txt

start "Intent Translator Backend" cmd /k "venv\Scripts\activate && uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

cd ..\frontend

if not exist node_modules (
    npm install
)

npm run build

cd ..

echo.
echo ==========================================
echo   Open http://localhost:8000
echo   Click "Index Knowledge Base" first!
echo ==========================================
pause
