# Drama Studio web app

The Next.js frontend for Drama Studio. See the [project guide](../README.md) for the demo, script format, local setup, live voice backend, and Vercel deployment instructions.

```bash
npm install
npm run dev
```

The development server runs at http://localhost:3000. Start the voice bridge separately as described in the project guide. Run `npm run build` for a production build and `npm start` to serve it.

Main files:

- `components/Studio.jsx`: script editor, generation controls, recorded takes, and playback.
- `lib/script.js`: presets, script parsing, and validation.
- `lib/audio.js`: WAV processing and audio playback.
- `api.js`: voice server client.

The current interface does not expose the experimental `app/api/write-scene` route.
