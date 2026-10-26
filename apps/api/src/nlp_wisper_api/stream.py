"""Per-connection streaming state: energy VAD, rolling partials, and finals.

The client sends 16 kHz mono int16 PCM. While someone is speaking we
re-transcribe the current utterance every `partial_every_s` and send a
`partial`; once `end_silence_s` of silence follows speech (or the utterance
gets too long) we transcribe it one last time, send a `final`, and start over.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from .transcriber import SAMPLE_RATE, Transcriber, _is_hallucination

Send = Callable[[dict[str, Any]], Awaitable[None]]

_WINDOW = SAMPLE_RATE // 10  # 100 ms

log = logging.getLogger(__name__)


@dataclass
class StreamConfig:
    vad_threshold: float = 0.005  # RMS above this counts as speech (lowered to avoid truncating normal speech)
    end_silence_s: float = 0.7
    partial_every_s: float = 0.5
    min_partial_s: float = 0.8  # clips < 0.8s make Whisper guess
    max_utterance_s: float = 20.0
    preroll_s: float = 0.35  # audio kept from before speech starts
    prompt_chars: int = 150  # committed text fed back to Whisper as context


def _has_speech(audio: np.ndarray, threshold: float) -> bool:
    for start in range(0, audio.size, _WINDOW):
        win = audio[start : start + _WINDOW]
        if win.size and float(np.sqrt(np.mean(win**2))) >= threshold:
            return True
    return False


class StreamSession:
    def __init__(self, transcriber: Transcriber, cfg: StreamConfig, send: Send) -> None:
        self.t = transcriber
        self.cfg = cfg
        self.send = send
        self._lock = asyncio.Lock()
        self.reset()

    def reset(self) -> None:
        self.buf = np.zeros(0, dtype=np.float32)
        self.in_speech = False
        self.silence_s = 0.0
        self.new_audio = False
        self.last_partial_at = 0.0
        self.last_partial = ""
        self.history = ""
        # Buffer offsets of pauses that ended while a transcription was in
        # flight. Inference can take longer than a pause, so pauses are
        # recorded as audio arrives rather than checked only on the next tick.
        self.cuts: list[int] = []

    def feed(self, pcm16: bytes) -> float:
        """Append a chunk of int16 PCM; returns its RMS level."""
        chunk = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        if chunk.size == 0:
            return 0.0
        rms = float(np.sqrt(np.mean(chunk**2)))
        if rms >= self.cfg.vad_threshold:
            if self.in_speech and self.silence_s >= self.cfg.end_silence_s:
                preroll = int(self.cfg.preroll_s * SAMPLE_RATE)
                self.cuts.append(max(self.cuts[-1] if self.cuts else 0, self.buf.size - preroll))
            self.in_speech = True
            self.silence_s = 0.0
            self.buf = np.concatenate([self.buf, chunk])
        else:
            self.silence_s += chunk.size / SAMPLE_RATE
            self.buf = np.concatenate([self.buf, chunk])
            if not self.in_speech:
                self.buf = self.buf[-int(self.cfg.preroll_s * SAMPLE_RATE) :]
        self.new_audio = True
        return rms

    async def tick(self) -> None:
        async with self._lock:
            if self.cuts:
                await self._finalize(self.cuts[0])
                return
            if not self.in_speech:
                return
            duration = self.buf.size / SAMPLE_RATE
            if self.silence_s >= self.cfg.end_silence_s or duration >= self.cfg.max_utterance_s:
                await self._finalize(self.buf.size)
            elif (
                self.new_audio
                and duration >= self.cfg.min_partial_s
                and time.monotonic() - self.last_partial_at >= self.cfg.partial_every_s
            ):
                await self._partial()

    async def flush(self) -> None:
        async with self._lock:
            while self.cuts:
                await self._finalize(self.cuts[0])
            if self.in_speech:
                await self._finalize(self.buf.size)

    def _prompt(self) -> str:
        prompt = self.history[-self.cfg.prompt_chars :].strip()
        if _is_hallucination(prompt):
            return ""
        return prompt

    async def _partial(self) -> None:
        self.new_audio = False
        self.last_partial_at = time.monotonic()
        text = await self.t.transcribe(self.buf.copy(), self._prompt())
        log.debug(
            "partial %.1fs audio  %dms  %r",
            self.buf.size / SAMPLE_RATE,
            (time.monotonic() - self.last_partial_at) * 1000,
            text,
        )
        if text and not _is_hallucination(text) and text != self.last_partial:
            self.last_partial = text
            await self.send({"type": "partial", "text": text})

    async def _finalize(self, n: int) -> None:
        """Transcribe buf[:n] as one utterance and drop it from the buffer."""
        started = time.monotonic()
        text = await self.t.transcribe(self.buf[:n].copy(), self._prompt())
        # Keep anything after the cut, including audio that arrived meanwhile.
        rest = self.buf[n:]
        self.buf = rest
        self.cuts = [c - n for c in self.cuts if c > n]
        # A cut recorded mid-finalize can enclose nothing but silence.
        while self.cuts and not _has_speech(rest[: self.cuts[0]], self.cfg.vad_threshold):
            self.cuts.pop(0)
        self.in_speech = _has_speech(rest, self.cfg.vad_threshold)
        self.new_audio = self.in_speech
        self.last_partial = ""
        latency_ms = round((time.monotonic() - started) * 1000)
        log.info("final  %.1fs audio  %dms  %r", n / SAMPLE_RATE, latency_ms, text)
        if text and not _is_hallucination(text):
            self.history = f"{self.history} {text}".strip()[-500:]
        # An empty final tells the client to drop whatever partial it shows.
        await self.send(
            {
                "type": "final",
                "text": text,
                "audio_s": round(n / SAMPLE_RATE, 2),
                "latency_ms": latency_ms,
            }
        )
