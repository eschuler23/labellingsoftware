#!/bin/bash

# Function to kill processes on exit
cleanup() {
    echo "Stopping servers..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit
}

# Trap SIGINT (Ctrl+C)
trap cleanup SIGINT

# Setup/Activate Python Environment
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi
source .venv/bin/activate

echo "Installing/Updating Python dependencies..."
pip install fastapi uvicorn watchdog Pillow

echo "Starting Backend..."
# Run from root as per Readme
uvicorn server.app:app --reload &
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

# Wait for both processes
wait
