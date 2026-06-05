#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8003}"

cd "$ROOT_DIR"

# Create venv and install dependencies if missing
if [ ! -f ".venv/bin/activate" ]; then
  echo "Creating .venv with uv..."
  uv venv
  uv pip install -r requirements.txt
elif [ requirements.txt -nt .venv/.deps_installed ] 2>/dev/null || [ ! -f .venv/.deps_installed ]; then
  echo "Syncing dependencies..."
  uv pip install -r requirements.txt
  touch .venv/.deps_installed
fi

source .venv/bin/activate

# Kill any process already listening on the port
PID=$(lsof -ti ":$PORT" 2>/dev/null || true)
if [ -n "${PID:-}" ]; then
  echo "Killing process $PID on port $PORT..."
  kill "$PID" 2>/dev/null || true
  sleep 0.5
fi

exec python3 server.py --host "$HOST" --port "$PORT"
