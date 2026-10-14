# Drama Studio

Turn editable scripts into expressive, two-character conversations, then change a line or its delivery and generate another take.

**[Open the demo](https://sonic-oxygen-vbced03.vercel.app)**

## Try it

1. Play either saved **Box this lap** recording to hear the original scene and an edited version. These recordings work without a live voice server.
2. Choose **The Heist**, **The Secret**, or **Box this lap** to load a script.
3. Edit the dialogue and choose a delivery for each line, then click **Generate conversation**. Live generation requires the connected voice server to be online.
4. Listen to the result, edit the script, and generate another take to compare. Download audio you want to keep before leaving the page.

Use **Paste script** to import your own dialogue:

```text
Alex: Please tell me you got it.
Sam: Yes, but we should leave now.
```

Optional delivery directions go after the colon, for example `Alex: (anxious) Please tell me you got it.` The editor supports two speakers, up to 12 lines, and up to 300 characters per line. Start with two short lines; these input limits do not guarantee the model will finish longer scenes. Character names identify roles in the editor; changing a name does not clone that person's voice.

## What this repository includes

- A Next.js studio for editing scripts, listening to takes, and downloading WAV audio.
- A FastAPI bridge that connects the browser to a voice backend.
- Saved demo recordings and a mock backend for developing without model hardware.

**The SGLang-Omni integration and native C++/MLX inference implementation are not included in this repository yet.** We plan to publish that work through community pull requests or source code in the [SGLang-Omni open-source project](https://github.com/sgl-project/sglang-omni). This repository currently contains the application and its HTTP bridge, not the inference engine or model weights. Links to the implementation will be added when they are public; this is not a claim that the integration has already been merged upstream.

## Run locally without a model

Prerequisites: Python 3.10+ and Node.js 20+.

From the repository root, start the mock voice server:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt
DRAMA_BACKEND=mock python -m uvicorn server.app:app --port 8765
```

In another terminal, start the web app:

```bash
cd web
npm install
npm run dev
```

Open **http://localhost:3000**. Mock mode plays a fixed bundled sample regardless of the script; it does not synthesize speech. On macOS, `./start-demo.command` starts both services in mock mode.

## Connect live inference

The hackathon demo uses a separately running SGLang-Omni server on an Apple Silicon Mac. Once that external server is available, start this repository's bridge with:

```bash
source .venv/bin/activate
DRAMA_BACKEND=omni \
DRAMA_OMNI_URL=http://127.0.0.1:8093 \
python -m uvicorn server.app:app --port 8765
```

The external server must implement `POST /v1/audio/speech`, accept the bridge's Drama3 request fields, and return a mono, 44.1 kHz, PCM16 WAV with an `X-Finish-Reason` header. Cloning this repository alone does not install or start that server.

An experimental `DRAMA_BACKEND=mlx` adapter also exists. It requires a separately installed Drama3-compatible version of `mlx-audio` and model weights at `DRAMA_MODEL_PATH`; these dependencies are not installed by `server/requirements.txt`. The Python reference work is available in [mlx-audio PR #1018](https://github.com/Blaizzy/mlx-audio/pull/1018).

The native demo currently returns a complete audio take after generation. The bridge sends heartbeat messages while waiting, so a quiet connection does not have to remain idle until audio is ready. Generation remains experimental: longer scenes can stop early or contain silence. Saved recordings are available for playback independently of live generation.

## Deploy the web app to Vercel

1. Import this GitHub repository into Vercel and set **Root Directory** to `web`.
2. Set `NEXT_PUBLIC_DRAMA_API_URL` to your voice bridge's public **HTTPS** URL before building.
3. Deploy the Next.js app.
4. Allow the deployed site's exact origin when starting the bridge:

```bash
DRAMA_BACKEND=omni \
DRAMA_OMNI_URL=http://127.0.0.1:8093 \
DRAMA_ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:3000 \
python -m uvicorn server.app:app --port 8765
```

The browser calls the bridge directly. Vercel hosts the web app and saved recordings; it does not run the Mac's inference engine. For a local bridge, expose port 8765 through an HTTPS tunnel and keep the Mac, bridge, inference server, and tunnel running during live demonstrations. If the tunnel address changes, update the frontend setting or rebuild with the new URL.

The gear icon lets a viewer change the voice server address. A `?api=https://your-server.example` URL override takes precedence over the saved browser setting, which takes precedence over the build-time default. Use the full URL, including `https://`.

## Project layout

```text
web/                    Next.js application
server/app.py           FastAPI voice bridge and backend adapters
scripts/check-api.mjs   Generation protocol check
samples/                Mock audio and example scene
web/public/samples/     Browser-accessible demo recordings
```

`GET /health` reports the bridge's state. `POST /generate` accepts a scene and responds with newline-delimited JSON: `start`, optional `heartbeat`, `audio`, and `done` events, or an `error`. Audio events contain base64 WAV data. A **Cut short** label indicates the backend reported its generation limit; it is not a silence detector.

The protocol check performs generation, so run it only when you intend to use the selected backend:

```bash
node scripts/check-api.mjs http://127.0.0.1:8765
```
