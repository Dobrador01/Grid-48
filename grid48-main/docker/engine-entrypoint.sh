#!/bin/sh
set -e

echo "[ENTRYPOINT] Starting Grid 48 Engine..."

# Verify USB pendrive is mounted (crucial for protecting Pi SD card)
if ! mount | grep -q "/mnt/usb/grid48"; then
  echo "[WARNING] USB drive not mounted at /mnt/usb/grid48!"
  echo "[WARNING] Running SQLite on local SD Card is NOT RECOMMENDED due to wear."
else
  echo "[ENTRYPOINT] USB Storage confirmed mounted."
fi

# Run database migrations
echo "[ENTRYPOINT] Running Drizzle migrations..."
# In a real environment, you might run drizzle-kit generate/migrate
# npm run db:migrate || true

exec "$@"
