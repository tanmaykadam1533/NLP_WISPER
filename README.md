# NLP-wisper

Talk, and watch your words get typed out live in a Monkeytype-style UI.
Speech-to-text runs entirely on your Mac: Whisper on the Apple Silicon GPU via [MLX](https://github.com/ml-explore/mlx-examples/tree/main/whisper).

```
apps/
  api/   FastAPI + mlx-whisper (Python, uv)  → :8000
  web/   Vite + TypeScript UI                → :5173 (proxies /api and /ws to :8000)
```

It's a [Turborepo](https://turborepo.dev) monorepo. The Python app is a uv workspace
member that Turborepo discovers natively through its experimental
`experimentalPythonWorkspaces` flag, so it doesn't need a `package.json`.

## Requirements

- Apple Silicon Mac
- [uv](https://docs.astral.sh/uv/) ≥ 0.12, Node ≥ 20, pnpm

## Run

```bash
pnpm install
uv sync --all-packages
pnpm dev
```

Open http://localhost:5173, press **space**, and start talking. Press **space** again to stop and see your results. **esc** resets.

The first start downloads the model (~480 MB for `whisper-small.en`) into the Hugging Face cache.

## How it works

1. The browser captures the mic. An AudioWorklet (`apps/web/src/pcm-worklet.ts`) downsamples it to 16 kHz int16 and sends 100 ms chunks over a WebSocket.
2. The API (`apps/api/src/nlp_wisper_api/stream.py`) runs a simple energy VAD. While you speak it re-transcribes the current utterance about every 0.45 s and sends a `partial`. After 0.7 s of silence it sends a `final` and starts a new utterance.
3. Whisper runs in a dedicated worker process. Its decode loop holds the GIL, and in a thread it would starve the event loop that receives audio.
4. The UI (`apps/web/src/typer.ts`) types the difference between what's on screen and the latest text one character at a time, and "backspaces" whenever Whisper revises a partial.

## Configuration

Set these environment variables when running `pnpm dev`:

| Variable | Default | |
|---|---|---|
| `WHISPER_MODEL` | `mlx-community/whisper-small.en-mlx` | Use `whisper-base.en-mlx` for speed, `whisper-large-v3-turbo` for accuracy |
| `WHISPER_LANGUAGE` | `en` | Leave empty for auto-detect (needs a multilingual model) |
| `VAD_THRESHOLD` | `0.012` | Mic RMS that counts as speech. Raise it in noisy rooms |
| `LOG_LEVEL` | `INFO` | `debug` logs every partial with its latency |

Open http://localhost:5173/?debug to log every server message in the browser console.

## Other tasks

```bash
pnpm build   # vite build + uv build; the API then serves apps/web/dist at :8000
pnpm lint    # tsc + ruff
uv run --package nlp-wisper-api python apps/api/scripts/stream_file.py speech.wav   # stream a WAV without a mic
```
