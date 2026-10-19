#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "========================================================"
echo "  🎬 Werv Studio (Mac Apple Silicon 逐字稿剪輯工作站)"
echo "========================================================"

# 確保 Homebrew 路徑在環境變數最前
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 0. 晶片架構檢查與 Rosetta 自動轉譯切換
CURRENT_ARCH="$(uname -m)"
IS_ARM_CAPABLE="$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)"

if [ "$CURRENT_ARCH" = "x86_64" ]; then
  if [ "$IS_ARM_CAPABLE" = "1" ]; then
    echo "⚠️ 偵測到目前終端機以 Rosetta (x86_64 模擬) 模式運行。"
    echo "🚀 正在為您自動切換至 Apple Silicon (arm64) 原生模式啟動..."
    echo ""
    exec arch -arm64 /bin/bash "$0" "$@"
  else
    echo "❌ 錯誤：偵測到此台 Mac 為 Intel 處理器 (x86_64)。"
    echo "   Werv Studio 專為 Apple Silicon (M1/M2/M3/M4) 晶片與 MLX 原生設計，"
    echo "   無法在 Intel 舊款處理器上運行 mlx-whisper 硬體加速模型。"
    echo "   請使用配備 Apple M 系列晶片的 Mac 執行。"
    exit 1
  fi
fi

# 0.1 自動檢查並拉取 GitHub 最新版本 (完全免手動下指令)
if [ -d "$ROOT_DIR/.git" ]; then
  if git fetch --quiet origin main 2>/dev/null; then
    LOCAL_HASH=$(git rev-parse HEAD 2>/dev/null || echo "")
    REMOTE_HASH=$(git rev-parse origin/main 2>/dev/null || echo "")
    if [ -n "$LOCAL_HASH" ] && [ -n "$REMOTE_HASH" ] && [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
      echo "✨ 發現 GitHub 有新版本！正在自動更新至最新版..."
      git pull --ff-only origin main || true
      if [ -d "$ROOT_DIR/.venv" ]; then
        "$ROOT_DIR/.venv/bin/pip" install -q -r "$ROOT_DIR/backend/requirements.txt" 2>/dev/null || true
      fi
      if [ -d "$ROOT_DIR/frontend/node_modules" ]; then
        (cd "$ROOT_DIR/frontend" && npm install --silent 2>/dev/null || true)
      fi
      echo "🎉 自動更新完成！即將為您啟動..."
      echo ""
    fi
  fi
fi

# 1. 檢查系統基本依賴環境 (Homebrew / ffmpeg / python3 / node)
# 尋找原生 arm64 的 python3
PYTHON_BIN=""
for py in "/opt/homebrew/bin/python3" "$(command -v python3 2>/dev/null)" "/usr/bin/python3"; do
  if [ -x "$py" ]; then
    PY_ARCH=$("$py" -c "import platform; print(platform.machine())" 2>/dev/null || echo "")
    if [ "$PY_ARCH" = "arm64" ]; then
      PYTHON_BIN="$py"
      break
    fi
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="python3"
fi

MISSING_DEPS=""
if ! command -v ffmpeg &> /dev/null; then
  MISSING_DEPS="$MISSING_DEPS ffmpeg"
fi
if ! command -v python3 &> /dev/null && [ ! -x "/opt/homebrew/bin/python3" ]; then
  MISSING_DEPS="$MISSING_DEPS python"
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
# 檢查舊的 .venv 是否存在架構問題
if [ -d "$ROOT_DIR/.venv" ]; then
  VENV_ARCH=$("$ROOT_DIR/.venv/bin/python" -c "import platform; print(platform.machine())" 2>/dev/null || echo "corrupted")
  if [ "$VENV_ARCH" != "arm64" ]; then
    echo "⚠️ 偵測到舊的 .venv 架構異常 ($VENV_ARCH)，正在自動重建為 Apple Silicon (arm64)..."
    rm -rf "$ROOT_DIR/.venv"
  fi
fi

# 檢查關鍵依賴套件是否已完整安裝
VENV_NEEDS_INSTALL=0
if [ ! -d "$ROOT_DIR/.venv" ]; then
  echo "📦 正在建立原生 arm64 Python 虛擬環境 (.venv)..."
  "$PYTHON_BIN" -m venv "$ROOT_DIR/.venv"
  VENV_NEEDS_INSTALL=1
elif ! "$ROOT_DIR/.venv/bin/python" -c "import fastapi, mlx_whisper, silero_vad, torch" 2>/dev/null; then
  echo "📦 偵測到部分 AI 套件尚未安裝完整，正在修復與補裝..."
  VENV_NEEDS_INSTALL=1
fi

if [ "$VENV_NEEDS_INSTALL" -eq 1 ]; then
  echo "📦 正在升級 pip 與安裝依賴套件 (MLX Whisper, Silero VAD, PyTorch, FastAPI)..."
  "$ROOT_DIR/.venv/bin/pip" install --upgrade pip setuptools wheel
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
