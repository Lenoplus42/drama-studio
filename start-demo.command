#!/bin/bash
# Double-click in Finder (or run ./start-demo.command) to start the voice server + web UI.
# Default backend is mock. For the real model: DRAMA_BACKEND=mlx DRAMA_MODEL_PATH=... ./start-demo.command
cd "$(dirname "$0")"
set -e
if [ ! -d .venv ]; then python3 -m venv .venv; fi
source .venv/bin/activate
pip install -q -r server/requirements.txt
[ -d web/node_modules ] || (cd web && npm install)
export DRAMA_BACKEND="${DRAMA_BACKEND:-mock}"
python -m uvicorn server.app:app --port 8765 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
(sleep 6 && open http://localhost:3000) &
cd web && npm run dev
