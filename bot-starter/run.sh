#!/bin/bash
# Runs the bot with a restart loop. The in-process watchdog (see
# src/index.ts) exits the process if the connection goes silently dead
# (no clean disconnect, so the SDK's own automatic-reconnect never fires)
# — this loop is what actually gives it a fresh connection afterwards.
# Usage: same env vars as `npm start`, e.g.
#   BOT_NAME=alice ./run.sh
cd "$(dirname "$0")"
while true; do
  npm start
  echo "[run.sh] bot exited (code $?) — restarting in 3s"
  sleep 3
done
