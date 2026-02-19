#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo "Stopping servers..."
    if [ -n "${BACKEND_PID:-}" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
    if [ -n "${FRONTEND_PID:-}" ]; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT INT TERM

if [ ! -x ".venv/bin/python" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

echo "Installing/Updating Python dependencies..."
.venv/bin/python -m pip install --disable-pip-version-check fastapi uvicorn watchdog Pillow python-multipart

echo "Starting Backend..."
.venv/bin/python -m uvicorn server.app:app --reload --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

echo "Setting up Frontend..."
cd web
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm install
fi

echo "Starting Frontend..."
npm run dev &
FRONTEND_PID=$!

wait "$BACKEND_PID" "$FRONTEND_PID"
