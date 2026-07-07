#!/bin/bash
# Double-click this file to start the Customer Assignment Tool.
# First run takes a minute or two (it downloads what it needs); after that it's fast.
cd "$(dirname "$0")"

echo "=============================================="
echo "  Customer Assignment Tool"
echo "=============================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed yet (it's free, from the official site)."
  echo "Opening the download page — install the big green 'LTS' version,"
  echo "then double-click this file again."
  open "https://nodejs.org" 2>/dev/null || true
  echo ""
  read -r -p "Press Enter to close this window..."
  exit 1
fi

echo "[1/4] Getting the app's parts (only slow the first time)..."
npm install --no-audit --no-fund || { read -r -p "Something went wrong. Press Enter to close..."; exit 1; }

echo "[2/4] Loading sample data (skipped if already loaded)..."
npm run seed

if [ ! -f "client/dist/index.html" ]; then
  echo "[3/4] Preparing the app (first time only)..."
  npm run build || { read -r -p "Something went wrong. Press Enter to close..."; exit 1; }
else
  echo "[3/4] App already prepared — skipping."
fi

echo "[4/4] Starting... your browser will open in a few seconds."
echo ""
echo "  The tool runs at:  http://localhost:3001"
echo "  To STOP it, just close this window."
echo ""
( sleep 3 && open "http://localhost:3001" 2>/dev/null ) &
npm start
