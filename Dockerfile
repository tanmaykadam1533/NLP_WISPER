# --- Stage 1: Build Frontend ---
FROM node:20-slim AS frontend-builder
WORKDIR /app/apps/web

# Copy web package files and install dependencies
COPY apps/web/package*.json ./
RUN npm ci || npm install

# Copy web source and build
COPY apps/web ./
RUN npm run build

# --- Stage 2: Python Backend & Final Image ---
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (ffmpeg is needed for Whisper audio processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy API backend code
COPY apps/api /app/apps/api

# Copy the built frontend from Stage 1
COPY --from=frontend-builder /app/apps/web/dist /app/apps/web/dist

# Set Python path so nlp_wisper_api is directly importable
ENV PYTHONPATH="/app/apps/api/src"

# Default cloud environment variables
ENV HOST=0.0.0.0
ENV PORT=8000
ENV WEB_DIST=/app/apps/web/dist
ENV WHISPER_MODEL=base.en
ENV WHISPER_LANGUAGE=en

EXPOSE 8000

# Start server
CMD ["python", "-m", "nlp_wisper_api.main"]
