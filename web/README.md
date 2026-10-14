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
