# AGENTS.md — Werv AI Debugging & Environment Repair Guide

> **Target Audience**: AI Coding Assistants (Jetski, Antigravity, Claude Code, Cursor) and Developers troubleshooting Werv on secondary or older Mac machines.

---

## 1. System Overview & Architecture

Werv is an AI-powered video editing and subtitle generation application tailored for macOS Apple Silicon.

- **Backend**: FastAPI running on Python 3.11/3.12 (Port `8000`).
  - Audio extraction & silence detection: `silero-vad` + `torch` (MPS/CPU).
  - Speech-to-Text: Apple `mlx` + `mlx-whisper` (Metal GPU accelerated).
  - Subtitle rendering & video export: `Pillow` (FreeType TTF/TTC glyph overlay) + `ffmpeg` (Dual encoder: `h264_videotoolbox` with automatic fallback to `libx264`).
- **Frontend**: React 18 + Vite + TypeScript + Tailwind CSS (Port `5173`).
- **Launcher**: `start.sh` (or `Werv.app` / `Werv.command`), which starts both services and streams stdout/stderr to disk.

---

## 2. Centralized Logs Location

All runtime outputs and exceptions are persistently saved to `logs/` in the project root:

| Log File | Description |
|---|---|
| `logs/backend.log` | FastAPI requests, FFmpeg execution commands, stderr outputs, and Python tracebacks (Rotating 10MB x 5). |
| `logs/frontend.log` | Vite build/dev server output and bundling warnings. |

> [!TIP]
> If a user reports that "export failed" or "ASR failed", your **first step** as an AI agent should always be:
> ```bash
> tail -n 120 logs/backend.log
> ```

---

## 3. Fast Diagnostic Playbook

### Step 1: Run the Automated Diagnostic Suite
Run the built-in diagnostic tool with Python from the project virtual environment:

```bash
# Human-readable colored CLI report
./.venv/bin/python scripts/diagnose.py

# Machine-readable JSON output for AI automated parsing
./.venv/bin/python scripts/diagnose.py --json
```

### Step 2: Check Active Diagnostics via HTTP (if backend is running)
```bash
# Check system capability, MLX status, FFmpeg encoders, and fonts
curl -s http://127.0.0.1:8000/api/system/diagnostics | jq .

# Fetch recent backend log lines
curl -s "http://127.0.0.1:8000/api/system/logs?lines=100" | jq .logs -r
```

---

## 4. Common Failure Modes & Decision Trees

### Scenario A: Video / Subtitle Export Fails (`POST /api/export` returns 500)

#### Symptoms:
- Frontend displays "匯出失敗" (Export Failed).
- `logs/backend.log` contains `RuntimeError: FFmpeg 匯出失敗`.

#### Root Causes & Fixes:
1. **VideoToolbox Hardware Encoding Incompatibility**:
   - *Cause*: On older macOS versions, Intel Macs, or certain FFmpeg builds, `h264_videotoolbox` fails session creation or rejects 10-bit color.
   - *Fix*: `backend/exporter.py` automatically falls back to `libx264`. If `libx264` also fails, check if FFmpeg has `libx264` installed:
     ```bash
     ffmpeg -encoders | grep libx264
     ```
     If missing, reinstall FFmpeg via Homebrew:
     ```bash
     brew reinstall ffmpeg
     ```
2. **FFmpeg Filter Script Syntax (`-/filter_complex` vs `-filter_complex_script`)**:
   - *Cause*: FFmpeg versions prior to 7.0 do not support `-/filter_complex` standard input syntax.
   - *Fix*: `backend/exporter.py` automatically retries with `-filter_complex_script <temp_file>`. Ensure FFmpeg is at least version 4.4+.
3. **Non-Standard Font Paths or TTC Index Missing**:
   - *Cause*: macOS font paths differ between OS releases (`/System/Library/Fonts/Supplemental/` vs `/System/Library/Fonts/`).
   - *Fix*: Run `./.venv/bin/python scripts/diagnose.py`. Inspect `check_fonts()`. If a font fails to load, `load_macos_font()` in `backend/exporter.py` will fall back across PingFang, STHeiti, Hiragino, and Arial Unicode.

---

### Scenario B: Speech Recognition / Transcription Fails (`POST /api/transcribe` 500)

#### Symptoms:
- Frontend stuck at "轉錄中..." or crashes immediately.
- Terminal logs show `Metal kernel compilation error`, `Symbol not found`, or `Abort trap: 6`.

#### Root Causes & Fixes:
1. **macOS Version Too Old for MLX**:
   - *Cause*: Apple MLX requires macOS **>= 13.5** (Ventura). macOS **14+ (Sonoma)** or **15+ (Sequoia)** is strongly recommended. On older macOS, Metal shaders fail to compile at runtime.
   - *Fix*:
     - Check macOS version: `sw_vers`
     - Have the user upgrade macOS via **System Settings -> General -> Software Update**.
2. **Rosetta x86_64 Emulation Mode**:
   - *Cause*: Terminal was launched under Rosetta (`arch` returns `i386` or `x86_64`), preventing MLX arm64 Metal acceleration.
   - *Fix*:
     - Check architecture: `uname -m`
     - If it returns `x86_64` on Apple Silicon, launch native Terminal: `arch -arm64 zsh`.
3. **Corrupted Model Download / HuggingFace Cache**:
   - *Cause*: Incomplete Whisper model checkpoint in `~/.cache/huggingface/hub/`.
   - *Fix*:
     ```bash
     rm -rf ~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo
     ```
     Restart Werv to re-download cleanly.

---

### Scenario C: Subtitles Display Blank Blocks, `?`, or Missing Glyphs

#### Symptoms:
- Subtitle box appears on video, but Chinese characters are invisible, replaced by square boxes, or punctuation is misaligned.

#### Root Causes & Fixes:
1. **Simplified vs Traditional TTC Sub-Font Selection**:
   - *Cause*: Apple's `Songti.ttc` contains multiple faces:
     - Index `0` / `1` = Songti SC (Simplified Chinese; lacks common Traditional characters like `沒`, `權`, `這`, `灣`).
     - Index `2` = Songti TC Bold (100% Traditional Chinese coverage).
     - Index `7` = Songti TC Regular.
   - *Fix*: Ensure `load_macos_font` in `backend/exporter.py` checks glyph coverage using `font.getmask()` and loads index `2` or `7`.
2. **Custom / Third-party Font Missing**:
   - Default to `pingfang` or `songti`, which are pre-installed on macOS.

---

### Scenario D: Port Conflict (Port 8000 or 5173 occupied)

#### Symptoms:
- `uvicorn` fails with `[Errno 48] Address already in use`.

#### Fix:
```bash
# Kill stale backend / frontend processes
lsof -ti :8000 | xargs kill -9 2>/dev/null || true
lsof -ti :5173 | xargs kill -9 2>/dev/null || true
pkill -f "uvicorn.*backend.main:app" 2>/dev/null || true
pkill -f "vite.*5173" 2>/dev/null || true
```

---

### Scenario E: Python Environment / Dependency Mismatch

#### Fix: Rebuilding `.venv`
If the Python environment on the other machine has corrupted wheels or Python version incompatibilities:

```bash
cd /path/to/werv

# 1. Remove broken venv
rm -rf .venv

# 2. Re-create virtual environment with Python 3.11 or 3.12
python3 -m venv .venv

# 3. Activate and upgrade pip
source .venv/bin/activate
pip install --upgrade pip setuptools wheel

# 4. Install dependencies
pip install -r backend/requirements.txt

# 5. Verify installation
python scripts/diagnose.py
```

---

## 5. Directory & File Reference

```
werv/
├── AGENTS.md                  # This file (AI debugging guide)
├── README.md                  # User project overview
├── start.sh                   # Main production launcher (dual process + logger)
├── Werv.command               # macOS double-clickable launcher
├── .gitignore                 # Excludes storage/, .venv/, and logs/
├── logs/                      # Centralized persistent logs
│   ├── backend.log            # Rotating backend log (FastAPI + FFmpeg)
│   └── frontend.log           # Frontend build and dev server log
├── scripts/
│   └── diagnose.py            # Automated diagnostic CLI (--json supported)
├── backend/
│   ├── logger.py              # Centralized logging module
│   ├── main.py                # FastAPI endpoints & diagnostics API
│   ├── exporter.py            # FFmpeg dual-encoder exporter & font loader
│   ├── asr_engine.py          # MLX Whisper & Silero VAD transcription
│   ├── models.py              # Pydantic data schemas
│   └── requirements.txt       # Python package dependencies
└── frontend/
    ├── src/                   # React components & UI
    └── package.json           # Frontend dependencies
```

---

## 6. One-Liner Quick Commands for Agents

```bash
# Quick health check
./.venv/bin/python scripts/diagnose.py

# Check latest 50 lines of backend logs
tail -n 50 logs/backend.log

# Check recent errors specifically
grep -E "ERROR|CRITICAL|Traceback|Exception|FAIL" logs/backend.log | tail -n 30

# Clean storage cache if disk is full
rm -rf storage/exports/* storage/uploads/*
```
