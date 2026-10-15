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

import anyio
import httpx

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

ROOT = Path(__file__).resolve().parents[1]
HEARTBEAT_INTERVAL_SECONDS = 10

BOX_DEMO_TEXT = "\n".join([
    "<|speaker:0|> Box this lap, box this lap. We're switching to softs.",
    "<|speaker:1|> Softs? The rear tyres are already on fire.",
    "<|speaker:0|> Trust the strategy. Gap to the car behind is two point one.",
    "<|speaker:1|> You said that last race, and we finished in the gravel.",
    "<|speaker:0|> Then don't brake in the gravel this time.",
    "<|speaker:1|> Copy. Pushing now.",
])
BOX_DEMO_SEED = 6009981471313978998

DEMO_SEEDS = {
    BOX_DEMO_TEXT: BOX_DEMO_SEED,
    "<|speaker:0|> Please tell me you got it.\n<|speaker:1|> Yes, but we should leave now.": 2895390944680674525,
    "<|speaker:0|> Did you tell him our secret?\n<|speaker:1|> He knew before we even met.": 126013838323777362,
}


class Line(BaseModel):
    model_config = ConfigDict(extra="forbid")
    speaker: Literal[0, 1]
    text: str = Field(min_length=1, max_length=300)
    emotion: Literal["neutral", "anxious", "laughs", "whispers", "sighs"] = "neutral"

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
    return "\n".join(
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
        self.mode = "mlx" if mode == "omni" else mode
        self.omni_url = os.getenv("DRAMA_OMNI_URL", "http://127.0.0.1:8093") if mode == "omni" else None
        self.model = None
        self.rate = 44100
        if mode == "mlx":
            import mlx.core as mx
            from mlx_audio.tts.utils import load_model
            mx.random.seed(42)
            self.model = load_model(os.environ["DRAMA_MODEL_PATH"])
            self.rate = self.model.sample_rate
        elif mode not in ("mock", "omni"):
            raise ValueError("DRAMA_BACKEND must be mock, mlx or omni")

    def generate(self, scene: Scene):
        if self.mode == "mock":
            with wave.open(str(ROOT / "samples/dialogue.wav"), "rb") as sample:
                while pcm := sample.readframes(14112):
                    yield pcm, False
            return
        import mlx.core as mx
        import numpy as np
        seed = os.getenv("DRAMA_SEED")
        if seed is not None:
            mx.random.seed(int(seed))
        segment_frames = {}
        for result in self.model.generate(
            text=render_scene(scene), stream=True, first_chunk_frames=4, max_tokens=512
        ):
            segment = result.segment_idx
            segment_frames[segment] = segment_frames.get(segment, 0) + result.token_count
            audio = np.asarray(result.audio)
            pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
            yield pcm, any(count >= 512 for count in segment_frames.values())


async def audio_chunks(backend: Backend, scene: Scene):
    if backend.omni_url:
        text = render_scene(scene)
        request = {"model": "drama3-native-mlx", "input": text,
                   "response_format": "wav", "max_new_tokens": 512}
        if text in DEMO_SEEDS:
            request["seed"] = DEMO_SEEDS[text]
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10)) as client:
            response = await client.post(
                f"{backend.omni_url}/v1/audio/speech", json=request,
            )
            response.raise_for_status()
            capped = response.headers["X-Finish-Reason"] == "length"
            with wave.open(io.BytesIO(response.content), "rb") as audio:
                if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, backend.rate):
                    raise ValueError("Omni returned an unsupported WAV format")
                yield audio.readframes(audio.getnframes()), capped
        return
    loop = asyncio.get_running_loop()
    iterator = backend.generate(scene)
    try:
        while (chunk := await loop.run_in_executor(app.state.pool, next_chunk, iterator)) is not None:
            yield chunk
    finally:
        await asyncio.shield(loop.run_in_executor(app.state.pool, iterator.close))


def next_chunk(iterator):
    return next(iterator, None)


def event(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False) + "\n"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = ThreadPoolExecutor(max_workers=1)
    app.state.busy = False
    app.state.last_outcome = None
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
    return {"ready": True, "backend": app.state.backend.mode, "busy": app.state.busy,
            "last_outcome": app.state.last_outcome}


@app.post("/v1/scene/audio")
async def generate(scene: Scene):
    if app.state.busy:
        raise HTTPException(status_code=409, detail="A scene is already generating")
    app.state.busy = True
    app.state.last_outcome = None
    backend = app.state.backend
    chunks = audio_chunks(backend, scene)

    async def stream():
        count = 0
        samples = 0
        truncated = False
        pending = None
        outcome = "interrupted"
        try:
            yield event({"type": "start", "version": 1, "backend": backend.mode,
                         "sample_rate": backend.rate, "channels": 1, "format": "wav-pcm16"})
            while True:
                pending = asyncio.create_task(anext(chunks))
                while not pending.done():
                    done, _ = await asyncio.wait({pending}, timeout=HEARTBEAT_INTERVAL_SECONDS)
                    if not done:
                        yield event({"type": "heartbeat"})
                try:
                    pcm, capped = pending.result()
                except StopAsyncIteration:
                    pending = None
                    break
                pending = None
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
            outcome = "completed"
            yield event({"type": "done", "chunks": count,
                         "duration_seconds": samples / backend.rate, "truncated": truncated})
        except Exception:
            import logging
            outcome = "failed"
            logging.exception("Scene generation failed")
            yield event({"type": "error", "message": "Generation failed; inspect server logs"})
        finally:
            with anyio.CancelScope(shield=True):
                try:
                    if pending is not None:
                        pending.cancel()
                        await asyncio.gather(pending, return_exceptions=True)
                    await chunks.aclose()
                finally:
                    app.state.last_outcome = outcome
                    app.state.busy = False

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"})
