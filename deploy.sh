#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="/home/admin/domains/chatmodz.com/public_html"
API_PROCESS="chatmodz-api"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$APP_DIR"

echo "Chatmodz Deploy — $APP_DIR"
echo "[1/5] Pulling latest changes..."

if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash push -m "auto-stash before Chatmodz deploy $STAMP"
fi

git fetch origin main
git reset --hard origin/main

echo "[2/5] Installing dependencies..."
pnpm install --frozen-lockfile

echo "[3/5] Building Chatmodz web..."
pnpm --filter @workspace/chatmodz run build

echo "[4/5] Building Chatmodz API..."
pnpm --filter @workspace/chatmodz-api run build

echo "[5/5] Publishing Chatmodz and restarting only $API_PROCESS..."
cp -a "$APP_DIR/artifacts/chatmodz/dist/." "$WEB_ROOT/"
pm2 restart "$API_PROCESS"

echo
echo "Chatmodz deploy complete."
echo "Commit: $(git rev-parse --short HEAD)"
pm2 status "$API_PROCESS"