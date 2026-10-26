"""FastAPI app: /api/health and the /ws/transcribe streaming endpoint."""

import asyncio
import contextlib
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .stream import StreamConfig, StreamSession
from .transcriber import Transcriber

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(), format="%(levelname)s  %(name)s  %(message)s"
)
log = logging.getLogger("nlp_wisper_api")

MODEL = os.getenv("WHISPER_MODEL", "mlx-community/whisper-small.en-mlx")
LANGUAGE = os.getenv("WHISPER_LANGUAGE", "en")
if LANGUAGE and LANGUAGE.lower() in ("auto", "none", ""):
    LANGUAGE = None
STREAM_CONFIG = StreamConfig(vad_threshold=float(os.getenv("VAD_THRESHOLD", "0.005")))
# Built frontend (pnpm build), served at / when present.
WEB_DIST = Path(os.getenv("WEB_DIST", Path(__file__).resolve().parents[3] / "web" / "dist"))

transcriber = Transcriber(MODEL, LANGUAGE)
_background: set[asyncio.Task] = set()  # keeps fire-and-forget tasks alive


@asynccontextmanager
async def lifespan(_: FastAPI):
    await transcriber.warmup()
    yield
    transcriber.close()


app = FastAPI(title="NLP-wisper API", lifespan=lifespan)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL, "language": LANGUAGE}


@app.websocket("/ws/transcribe")
async def transcribe_ws(ws: WebSocket) -> None:
    await ws.accept()
    session = StreamSession(transcriber, STREAM_CONFIG, ws.send_json)
    await ws.send_json({"type": "ready", "model": MODEL, "language": LANGUAGE})

    async def ticker() -> None:
        while True:
            await asyncio.sleep(0.1)
            await session.tick()

    task = asyncio.create_task(ticker())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                session.feed(msg["bytes"])
                continue
            data = json.loads(msg.get("text") or "{}")
            if data.get("type") == "flush":
                await session.flush()
                await ws.send_json({"type": "flushed"})
            elif data.get("type") == "reset":
                # Sent when the user starts a new run: page the model in now.
                session.reset()
                warm = asyncio.create_task(transcriber.touch())
                _background.add(warm)
                warm.add_done_callback(_background.discard)
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")


def run() -> None:
    uvicorn.run("nlp_wisper_api.main:app", host="127.0.0.1", port=int(os.getenv("API_PORT", "8000")))


if __name__ == "__main__":
    run()
