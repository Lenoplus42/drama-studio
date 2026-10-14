import asyncio
import base64
import io
import json
import os
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

ROOT = Path(__file__).resolve().parents[1]


class Line(BaseModel):
    model_config = ConfigDict(extra="forbid")
    speaker: Literal[0, 1]
    text: str = Field(min_length=1, max_length=300)
    emotion: Literal["neutral", "laughs", "whispers", "sighs"] = "neutral"

    @field_validator("text")
    @classmethod
    def clean_text(cls, value: str) -> str:
        value = value.strip()
        if not value or "<|" in value:
            raise ValueError("Use the speaker field for speaker tags; text must not be blank")
        return value


class Scene(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lines: list[Line] = Field(min_length=1, max_length=12)


def render_scene(scene: Scene) -> str:
    return " ".join(
        f"<|speaker:{line.speaker}|> "
        + (f"[{line.emotion}] " if line.emotion != "neutral" else "")
        + line.text for line in scene.lines
    )


def wav_bytes(pcm: bytes, rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm)
    return buffer.getvalue()


class Backend:
    def __init__(self, mode: str):
        self.mode = mode
        self.model = None
        self.rate = 44100
        if mode == "mlx":
            from mlx_audio.tts.utils import load_model
            self.model = load_model(os.environ["DRAMA_MODEL_PATH"])
            self.rate = self.model.sample_rate
        elif mode != "mock":
            raise ValueError("DRAMA_BACKEND must be mock or mlx")

    def generate(self, scene: Scene):
        if self.mode == "mock":
            with wave.open(str(ROOT / "samples/dialogue.wav"), "rb") as sample:
                while pcm := sample.readframes(14112):
                    yield pcm, False
            return
        import numpy as np
        segment_frames = {}
        for result in self.model.generate(
            text=render_scene(scene), stream=True, first_chunk_frames=4, max_tokens=768
        ):
            segment = result.segment_idx
            segment_frames[segment] = segment_frames.get(segment, 0) + result.token_count
            audio = np.asarray(result.audio)
            pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
            yield pcm, any(count >= 768 for count in segment_frames.values())


def next_chunk(iterator):
    return next(iterator, None)


def event(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False) + "\n"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = ThreadPoolExecutor(max_workers=1)
    app.state.busy = False
    loop = asyncio.get_running_loop()
    app.state.backend = await loop.run_in_executor(
        app.state.pool, Backend, os.getenv("DRAMA_BACKEND", "mock")
    )
    yield
    app.state.pool.shutdown(wait=True)


app = FastAPI(title="Drama Studio", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("DRAMA_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(","),
    allow_methods=["GET", "POST"], allow_headers=["Content-Type"],
)


@app.get("/health")
async def health():
    return {"ready": True, "backend": app.state.backend.mode, "busy": app.state.busy}


@app.post("/v1/scene/audio")
async def generate(scene: Scene):
    if app.state.busy:
        raise HTTPException(status_code=409, detail="A scene is already generating")
    app.state.busy = True
    backend = app.state.backend
    iterator = backend.generate(scene)

    async def stream():
        loop = asyncio.get_running_loop()
        count = 0
        samples = 0
        truncated = False
        try:
            yield event({"type": "start", "version": 1, "backend": backend.mode,
                         "sample_rate": backend.rate, "channels": 1, "format": "wav-pcm16"})
            while (chunk := await loop.run_in_executor(app.state.pool, next_chunk, iterator)) is not None:
                pcm, capped = chunk
                truncated |= capped
                if not pcm:
                    continue
                yield event({"type": "audio", "index": count,
                             "audio_base64": base64.b64encode(wav_bytes(pcm, backend.rate)).decode(),
                             "duration_seconds": len(pcm) / 2 / backend.rate})
                count += 1
                samples += len(pcm) // 2
                if backend.mode == "mock":
                    await asyncio.sleep(0.05)
            yield event({"type": "done", "chunks": count,
                         "duration_seconds": samples / backend.rate, "truncated": truncated})
        except Exception:
            import logging
            logging.exception("Scene generation failed")
            yield event({"type": "error", "message": "Generation failed; inspect server logs"})
        finally:
            cleanup = loop.run_in_executor(app.state.pool, iterator.close)
            cleanup.add_done_callback(lambda future: setattr(app.state, "busy", False))
            await asyncio.shield(cleanup)

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})
