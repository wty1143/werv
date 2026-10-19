#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "========================================================"
echo "  🎬 Werv Studio (Mac Apple Silicon 逐字稿剪輯工作站)"
echo "========================================================"

# 1. 檢查系統基本依賴環境 (Homebrew / ffmpeg / python3 / node)
MISSING_DEPS=""
if ! command -v ffmpeg &> /dev/null; then
  MISSING_DEPS="$MISSING_DEPS ffmpeg"
fi
if ! command -v python3 &> /dev/null; then
  MISSING_DEPS="$MISSING_DEPS python3"
fi
if ! command -v node &> /dev/null; then
  MISSING_DEPS="$MISSING_DEPS node"
fi

if [ -n "$MISSING_DEPS" ]; then
  echo ""
  echo "⚠️ 偵測到您的 Mac 缺少以下工具：$MISSING_DEPS"
  echo "👉 請開啟終端機透過 Homebrew 一鍵安裝："
  echo "   brew install$MISSING_DEPS"
  echo ""
  if ! command -v brew &> /dev/null; then
    echo "💡 若您的 Mac 尚未安裝 Homebrew，請先貼上此指令安裝 Homebrew："
    echo '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo ""
  fi
  read -p "是否嘗試使用 brew 自動為您安裝缺少的工具？(y/n): " AUTO_INSTALL
  if [ "$AUTO_INSTALL" = "y" ] || [ "$AUTO_INSTALL" = "Y" ]; then
    brew install $MISSING_DEPS
  else
    echo "請安裝後再重新執行 ./start.sh"
    exit 1
  fi
fi

# 2. 建立本地儲存庫資料夾
mkdir -p "$ROOT_DIR/storage"

# 3. 自動初始化 Python 虛擬環境與安裝套件
if [ ! -d "$ROOT_DIR/.venv" ]; then
  echo "📦 第一次執行：正在建立 Python 虛擬環境 (.venv)..."
  python3 -m venv "$ROOT_DIR/.venv"
  echo "📦 正在安裝後端 AI 辨識依賴套件 (MLX Whisper, Silero VAD, FastAPI)..."
  "$ROOT_DIR/.venv/bin/pip" install --upgrade pip
  "$ROOT_DIR/.venv/bin/pip" install -r "$ROOT_DIR/backend/requirements.txt"
fi

# 4. 自動初始化前端 node_modules
if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  echo "📦 第一次執行：正在安裝前端介面套件 (React, Vite, Lucide)..."
  cd "$ROOT_DIR/frontend"
  npm install
  cd "$ROOT_DIR"
fi

# 5. 清理並退出處理
cleanup() {
  echo ""
  echo "正在關閉 Werv 前後端服務..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 6. 啟動後端與前端
echo "▶ 啟動 FastAPI 後端服務 (http://127.0.0.1:8000)..."
"$ROOT_DIR/.venv/bin/uvicorn" backend.main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

echo "▶ 啟動 React + Vite 前端介面 (http://localhost:5173)..."
cd "$ROOT_DIR/frontend"
npm run dev -- --port 5173 &
FRONTEND_PID=$!
cd "$ROOT_DIR"

sleep 2
echo ""
echo "========================================================"
echo "✅ Werv Studio 啟動成功！"
echo "👉 瀏覽器即將自動開啟：http://localhost:5173"
echo "========================================================"
echo "💡 提示：按 Ctrl + C 即可關閉程式"
echo ""

# 自動開啟瀏覽器
sleep 1
open "http://localhost:5173" 2>/dev/null || true

wait
