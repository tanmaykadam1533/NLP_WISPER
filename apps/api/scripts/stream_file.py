"""Stream a 16 kHz mono 16-bit WAV to the API in real time and print what comes back.

    uv run --package nlp-wisper-api python apps/api/scripts/stream_file.py speech.wav

Make a test file on macOS with:
    say -o speech.wav --data-format=LEI16@16000 "hello there, this is a test"
"""

import asyncio
import json
import sys
import time
import wave

import websockets

CHUNK = 1600  # 100 ms at 16 kHz


async def main(path: str, url: str) -> None:
    with wave.open(path, "rb") as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (16000, 1, 2), (
            "need 16 kHz mono int16"
        )
        pcm = w.readframes(w.getnframes())

    async with websockets.connect(url) as ws:
        print(json.loads(await ws.recv()))
        t0 = time.monotonic()

        async def reader() -> None:
            async for raw in ws:
                msg = json.loads(raw)
                print(f"{time.monotonic() - t0:6.2f}s  {msg}")
                if msg["type"] == "flushed":
                    return

        task = asyncio.create_task(reader())
        for i in range(0, len(pcm), CHUNK * 2):
            await ws.send(pcm[i : i + CHUNK * 2])
            await asyncio.sleep(CHUNK / 16000)
        await ws.send(json.dumps({"type": "flush"}))
        await task


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "ws://127.0.0.1:8000/ws/transcribe"))
