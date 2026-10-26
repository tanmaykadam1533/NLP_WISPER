# --- Stage 1: Build Frontend ---
FROM node:20-slim AS frontend-builder
WORKDIR /app

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Copy workspace configuration files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

# Copy frontend source code and build
COPY apps/web ./apps/web
RUN pnpm --filter web build

# --- Stage 2: Python Backend & Final Image ---
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (ffmpeg is needed for Whisper audio processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
RUN pip install --no-cache-dir \
    "fastapi>=0.115" \
    "uvicorn[standard]>=0.30" \
    "faster-whisper>=1.0.0" \
    "numpy"

# Copy API backend code and install
COPY apps/api /app/apps/api
RUN pip install --no-cache-dir --no-deps -e /app/apps/api

# Copy the built frontend from Stage 1
COPY --from=frontend-builder /app/apps/web/dist /app/apps/web/dist

# Default cloud environment variables
ENV HOST=0.0.0.0
ENV PORT=8000
ENV WEB_DIST=/app/apps/web/dist
ENV WHISPER_MODEL=base.en
ENV WHISPER_LANGUAGE=en

EXPOSE 8000

# Start server
CMD ["python", "-m", "nlp_wisper_api.main"]
