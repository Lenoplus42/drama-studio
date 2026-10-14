# Drama Studio — web

Next.js (App Router) front end for the voice server in `../server`. Dependencies are only `next`, `react` and `react-dom`; the server is called through the shared client `api.js`, unchanged.

## Run it

```bash
# terminal 1, repo root: mock voice server (see ../README.md)
python3 -m venv .venv && source .venv/bin/activate
pip install -r server/requirements.txt
python -m uvicorn server.app:app --port 8765

# terminal 2
cd web
npm install
npm run dev        # http://localhost:3000
```

The badge in the top right reads the server's `/health`: **Mock server** (amber, plays the fixed sample and ignores the script), **Live · Drama3 on MLX** (green), or offline. Each lap (take) is tagged Mock or Live from the stream's `start` event.

## Pointing at a different voice server

The page calls the server from the viewer's browser. In order of precedence:

1. `?api=http://host:8765` in the page URL
2. Server settings (gear icon), saved in this browser
3. `NEXT_PUBLIC_DRAMA_API_URL` at build time
4. `http://127.0.0.1:8765`

Same Wi-Fi, page on your laptop, model on Lennox's Mac: Lennox adds `--host 0.0.0.0` to the uvicorn command, and you set the address to `http://<lennox-ip>:8765`. The page's origin is `http://localhost:3000`, which the server already allows.

## Deploying to Vercel

Import the repo with **Root Directory = `web`** (Next.js is detected automatically), or run `npx vercel --prod` from this folder. No environment variables are required.

A deployed page still sends audio requests from the viewer's browser, so it only reaches a voice server running on the same machine (or one with a public HTTPS address). For the demo on the Mac that runs the model:

```bash
export DRAMA_ALLOWED_ORIGINS=https://<your-app>.vercel.app,http://localhost:3000
# then start uvicorn as in ../README.md
```

Open the Vercel URL in Chrome on that Mac and allow local network access if Chrome asks. Visitors without a reachable server see a **Hear a recorded take** button, which plays `public/samples/recorded-take.wav` (a copy of `samples/dialogue.wav`, recorded with Drama3 on MLX from the Mandarin sample scene).

## Write with AI (optional)

**Write with AI** sends a picture and/or an idea to `app/api/write-scene/route.js`. The route calls Vercel AI Gateway (OpenAI-compatible `/v1/chat/completions`), which returns a scene in the same `Name: (direction) line` format that **Paste script** accepts. The picture also becomes the stage backdrop.

- Locally: put `AI_GATEWAY_API_KEY=...` in `web/.env.local`, then restart `npm run dev`.
- On Vercel: add `AI_GATEWAY_API_KEY` under Project → Settings → Environment Variables. On a Vercel deployment the route can also use the project's OIDC token instead of a key.
- Optional: set `DRAMA_WRITER_MODEL` to another vision model on the gateway. The default is `anthropic/claude-opus-5`.

Without a key, the dialog explains how to set one up and the rest of the app works as before.

## How the audio is handled

- Each `audio` event is a complete 16-bit mono WAV. The page reads the PCM out of each chunk (`lib/audio.js`) and schedules the chunks back to back on one `AudioContext`. If generation falls behind playback, the next chunk starts after a 0.3 s re-buffer instead of overlapping.
- Download joins the raw PCM of all chunks and writes one new WAV header, so it never concatenates WAV headers. On the mock this produces a file whose PCM is byte-identical to `samples/dialogue.wav`.
- Chunks don't line up with lines, so the stage shows one shared waveform and a level-driven light, not a per-line highlight.
- Stop aborts the request (`AbortController`); a cancelled take is discarded. If the next request gets HTTP 409 while the server is still cleaning up, the page retries up to 4 times, 0.9 s apart.
- A take whose `done` event has `truncated: true` is tagged **Cut short**.

## Limits mirrored from the server

`lib/script.js` holds `MAX_CAST = 2` (server `speaker: Literal[0, 1]`), `MAX_LINES = 12` and `MAX_CHARS = 300`. To allow more voices, change the server's `Literal` and `MAX_CAST` together.

## Files

- `components/Studio.jsx` — the whole studio UI (client component)
- `lib/audio.js` — WAV parse/encode, peak envelope, gapless stream player
- `lib/script.js` — sample scenes, validation, request shaping, paste-a-script parser
- `app/` — Next.js layout, page and global styles

## Live integration handoff (MLX backend ↔ web)

Status at handoff: the web UI is tested only against the mock protocol (85 chunks / 27.07 s, cancel, 409 retry, download byte-identical). It has not yet been run against the real MLX server.

1. **Start the real server** (on the Mac with the model):
   ```bash
   export DRAMA_BACKEND=mlx
   export DRAMA_MODEL_PATH=/path/to/drama3-3bit
   # Add every origin the page is served from. localhost:3000 is the default.
   export DRAMA_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
   python -m uvicorn server.app:app --port 8765            # same machine as the page
   # page on another laptop: add --host 0.0.0.0 and that page's origin, e.g. http://<laptop-ip>:3000
   ```
2. **Protocol check:** `node scripts/check-api.mjs http://127.0.0.1:8765` must pass.
3. **Start the web app:** `cd web && npm install && npm run dev` → http://localhost:3000. For a server on another machine, open `http://localhost:3000/?api=http://<server-ip>:8765` (or use the gear icon).
4. **Verify in the UI:** the badge reads "Live · Drama3 on MLX" and new laps are tagged Live. The start lights should go out when the first audio arrives, and the First audio, Audio and Speed readouts should fill in. Download a lap, play the WAV, and check that it isn't truncated.
5. **Things to check against the real model:**
   - English quality. The default preset ("Box this lap") is English; Drama3 is only verified on Mandarin. If English is weak, change the default order in `lib/script.js` `PRESETS`.
   - Streaming smoothness. If generation is slower than realtime, you will hear gaps. Tune `lead` / `rebuffer` in `lib/audio.js` `StreamPlayer` (currently 0.12 s / 0.3 s), or buffer more before starting.
   - `truncated: true` shows a "Cut short" tag. If it appears often, shorten lines or raise `max_tokens` on the server.
   - More than 2 voices: change `Line.speaker: Literal[0, 1]` on the server and `MAX_CAST` in `lib/script.js` together.
6. **Do not change the HTTP/NDJSON protocol** without updating `web/api.js` and re-running `scripts/check-api.mjs` against both backends.
