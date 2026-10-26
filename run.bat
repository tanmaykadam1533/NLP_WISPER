@echo off
echo Starting NLP-wisper API Backend...
start "NLP-wisper API" cmd /k "set PYTHONPATH=apps\api\src&& python -m nlp_wisper_api.main"

echo Starting NLP-wisper Web Frontend...
start "NLP-wisper Web" cmd /k "cd apps\web && npm run dev"

echo Both services launched!
echo Web UI: http://localhost:5173
echo API Health: http://localhost:8000/api/health
pause
