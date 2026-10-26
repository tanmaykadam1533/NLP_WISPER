"""Async wrapper around mlx-whisper, running in its own worker process.

Whisper's decode loop is Python-heavy and holds the GIL; in a thread it starves
the event loop that is receiving audio, so inference lives in a separate process.
"""

import asyncio
import logging
import multiprocessing as mp
import os
import re
import threading
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

SAMPLE_RATE = 16_000

log = logging.getLogger(__name__)

# Phrases Whisper tends to "hear" in near-silence, noise, or repetitive loops.
_HALLUCINATIONS = {
    "",
    ".",
    "...",
    "you",
    "you.",
    "bye.",
    "thank you.",
    "thank you",
    "thanks for watching!",
    "thanks for watching",
    "thank you for watching.",
    "thank you for watching!",
    "thank you very much.",
    "thank you very much!",
    "thank you very much",
    "i don't know.",
    "i don't know",
    "i dont know.",
    "i dont know",
    "i do not know.",
    "i do not know",
    "subtitles by",
    "see you next time",
    "like and subscribe",
    "please subscribe",
}


def _is_hallucination(text: str) -> bool:
    if not text:
        return True
    clean = re.sub(r"[^\w\s]", "", text).strip().lower()
    if clean in {
        "",
        "you",
        "bye",
        "thank you",
        "thanks for watching",
        "thank you for watching",
        "thank you very much",
        "i dont know",
        "i do not know",
        "subtitles by",
        "see you next time",
        "like and subscribe",
        "please subscribe",
        "mbc",
        "silence",
        "music",
        "applause",
        "laughter",
    }:
        return True
    # Check if phrase is a repetition of identical sub-phrases (e.g. "I don't know, I don't know")
    parts = [p.strip() for p in re.split(r"[,.!?]\s*", text) if p.strip()]
    if len(parts) >= 2 and all(p.lower() == parts[0].lower() for p in parts):
        return True
    return False


# Set in the worker process by _init_worker.
_model = ""
_language: str | None = None
_backend = "mlx"
_fw_model = None


def _map_model_name(name: str) -> str:
    lower = name.lower()
    for size in [
        "tiny.en", "tiny",
        "base.en", "base",
        "small.en", "small",
        "medium.en", "medium",
        "large-v3-turbo", "large-v3", "large"
    ]:
        if size in lower:
            return size
    return "base"


def _init_worker(model: str, language: str | None, parent_pid: int) -> None:
    global _model, _language, _backend, _fw_model
    _model, _language = model, language
    os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

    # If the API is killed hard (or Ctrl-C'd mid-inference), don't linger
    # holding a gigabyte of model weights.
    def watch_parent() -> None:
        while True:
            time.sleep(1)
            try:
                if os.name == "nt":
                    import ctypes
                    SYNCHRONIZE = 0x00100000
                    h = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
                    if not h:
                        break
                    ctypes.windll.kernel32.CloseHandle(h)
                else:
                    if os.getppid() != parent_pid:
                        break
            except Exception:
                break
        os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()

    try:
        import mlx_whisper  # noqa: F401
        _backend = "mlx"
    except ImportError:
        import faster_whisper
        _backend = "faster-whisper"
        fw_name = _map_model_name(model)
        _fw_model = faster_whisper.WhisperModel(
            fw_name,
            device="auto",
            compute_type="int8",
            cpu_threads=4,
        )


def _transcribe(audio: np.ndarray, prompt: str) -> str:
    if _backend == "mlx":
        import mlx_whisper

        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=_model,
            language=_language,
            temperature=0.0,
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
            verbose=None,
        )
        parts = [
            seg["text"].strip()
            for seg in result.get("segments", [])
            if not (seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0)
        ]
    else:
        # Sanitize prompt so prior repetitions/hallucinations don't infect future transcriptions
        clean_prompt = None
        if prompt and not _is_hallucination(prompt):
            words = prompt.strip().split()
            if len(words) <= 15:
                clean_prompt = prompt.strip()
            else:
                clean_prompt = " ".join(words[-15:])

        segments, _ = _fw_model.transcribe(
            audio,
            language=_language,
            temperature=0.0,
            beam_size=1,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=250, threshold=0.4),
            no_speech_threshold=0.5,
            compression_ratio_threshold=2.2,
            repetition_penalty=1.2,
            condition_on_previous_text=False,
            initial_prompt=clean_prompt,
        )
        parts = []
        for seg in segments:
            t = seg.text.strip()
            if not t:
                continue
            if seg.no_speech_prob > 0.5 or seg.avg_logprob < -1.2 or seg.compression_ratio > 2.3:
                continue
            if not _is_hallucination(t):
                parts.append(t)

    text = " ".join(p for p in parts if p).strip()
    return "" if _is_hallucination(text) else text


class Transcriber:
    def __init__(self, model: str, language: str | None) -> None:
        self.model = model
        self.language = language or None
        self._pool: ProcessPoolExecutor | None = None
        self._touching = False

    async def warmup(self) -> None:
        """Start the worker and download (first run only) and load the model."""
        self._pool = ProcessPoolExecutor(
            max_workers=1,
            mp_context=mp.get_context("spawn"),
            initializer=_init_worker,
            initargs=(self.model, self.language, os.getpid()),
        )
        log.info("loading whisper model %s ...", self.model)
        await self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))
        log.info("model ready")

    async def touch(self) -> None:
        """Tiny inference so the model is paged in before speech arrives.

        On a RAM-starved machine the idle worker gets swapped out, and the
        first real partial would otherwise pay seconds of page-in cost.
        """
        if self._touching:
            return
        self._touching = True
        try:
            await self.transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
        finally:
            self._touching = False

    async def transcribe(self, audio: np.ndarray, prompt: str = "") -> str:
        assert self._pool, "call warmup() first"
        return await asyncio.get_running_loop().run_in_executor(self._pool, _transcribe, audio, prompt)

    def close(self) -> None:
        if self._pool:
            self._pool.shutdown(wait=True, cancel_futures=True)

