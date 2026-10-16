#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "========================================================"
echo "  🎬 Werv Studio (Mac Apple Silicon 逐字稿剪輯工作站)"
echo "========================================================"

# Cleanup background processes on exit
cleanup() {
  echo ""
  echo "正在關閉 Werv 前後端服務..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▶ 啟動 FastAPI 後端服務 (http://127.0.0.1:8000)..."
"$ROOT_DIR/.venv/bin/uvicorn" backend.main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

echo "▶ 啟動 React + Vite 前端介面 (http://localhost:5173)..."
cd "$ROOT_DIR/frontend"
NPM_CONFIG_CACHE=/tmp/npm-cache npm run dev -- --port 5173 &
FRONTEND_PID=$!

sleep 2
echo ""
echo "✅ Werv 已啟動！請在瀏覽器開啟："
echo "   👉 http://localhost:5173"
echo ""
wait
