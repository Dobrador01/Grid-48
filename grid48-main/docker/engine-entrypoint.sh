#!/bin/sh
set -e

echo "[ENTRYPOINT] Starting Grid 48 Engine..."

# Pendrive enforcement: SQLite WAL on the Pi SD card destroys it within months.
# /app/data MUST be a real mountpoint (the USB drive bound from the host).
# Override only for local development (PC, no pendrive) via SKIP_PENDRIVE_CHECK=1.
if [ "${SKIP_PENDRIVE_CHECK}" = "1" ]; then
  echo "[WARN] SKIP_PENDRIVE_CHECK=1 — running without pendrive enforcement (DEV ONLY)."
elif ! grep -q " /app/data " /proc/mounts; then
  echo "[FATAL] /app/data is not a mountpoint. Pendrive missing — refusing to start."
  echo "[FATAL] SQLite on SD card kills the card. Mount the USB drive and retry."
  exit 1
else
  echo "[ENTRYPOINT] USB storage confirmed mounted at /app/data."
fi

echo "[ENTRYPOINT] Running Drizzle migrations..."
npm run db:migrate

exec "$@"
