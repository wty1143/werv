# AGENTS.md — Werv AI Debugging & Environment Repair Guide

> **Target Audience**: AI Coding Assistants (Jetski, Antigravity, Claude Code, Cursor) and Developers troubleshooting Werv on secondary Apple Silicon Macs (e.g., Apple M1 / M2).

---

## 1. System Architecture & Hardware Standard

Werv is built exclusively for **Apple Silicon (M1, M2, M3, M4)** and relies on native macOS hardware acceleration:

- **Speech-to-Text**: Apple `mlx` + `mlx-whisper` (Metal GPU accelerated).
- **Audio Processing**: `silero-vad` + `torch` (MPS device / Apple Neural Engine).
- **Subtitle Overlay & Video Export**: `Pillow` (native FreeType rendering) + `ffmpeg` (Apple VideoToolbox hardware encoder: `h264_videotoolbox`).
- **Core Principle**: **Do NOT silently downgrade to software encoding (libx264) or CPU mode.** Both M1 and M2 share the same hardware VideoToolbox media engine and Metal support. If an export or transcription fails on M1, there is a specific environmental or system-level cause that must be diagnosed and resolved.

---

## 2. Centralized Logs

All outputs, full FFmpeg commands, stderr outputs, and Python tracebacks are saved to:

| Log File | Description |
|---|---|
| `logs/backend.log` | FastAPI requests, exact FFmpeg CLI invocations, stderr messages, and full Python tracebacks (Rotating 10MB x 5). |
| `logs/frontend.log` | Vite build/dev server output and bundling warnings. |

> [!IMPORTANT]
> When troubleshooting a failure on the M1 Mac, **always inspect the logs first**:
> ```bash
> tail -n 120 logs/backend.log
> ```

---

## 3. One-Shot Diagnostic Playbook

Run the diagnostic suite inside the project virtual environment:

```bash
# Terminal report (Checks chip model, macOS version, MLX Metal, FFmpeg VideoToolbox, Fonts, and 0.5s hardware export test)
./.venv/bin/python scripts/diagnose.py

# JSON output for automated AI parsing
./.venv/bin/python scripts/diagnose.py --json
```

Or query the live backend API (if running):
```bash
curl -s http://127.0.0.1:8000/api/system/diagnostics | jq .
curl -s "http://127.0.0.1:8000/api/system/logs?lines=100" | jq .logs -r
```

---

## 4. Root Cause Analysis: Why Might M1 Fail When M2 Works?

Since M1 and M2 both have the Apple Silicon VideoToolbox media engine and Metal GPU, issues on M1 are strictly environmental:

### 1. macOS Version Is Too Old (Most Likely Cause for ASR / Transcription Failure)
* **Symptom**: `mlx_whisper` crashes or throws `Metal kernel compilation error`, `Symbol not found: _MTL...`, or `Abort trap: 6`.
* **Root Cause**: The M1 Mac may be on macOS 11 (Big Sur) or macOS 12 (Monterey). Apple MLX requires macOS **>= 13.5 (Ventura)**, and MLX Whisper's Metal shaders require **macOS 14+ (Sonoma)** or **macOS 15+ (Sequoia)** for stable compilation.
* **Fix**:
  1. Check OS version: `sw_vers`
  2. Have the user upgrade macOS via **System Settings -> General -> Software Update** to macOS 14+ (Sonoma) or 15+ (Sequoia).

### 2. FFmpeg VideoToolbox Support or Binary Architecture
* **Symptom**: `FFmpeg VideoToolbox 匯出失敗 (exit code ...)`.
* **Root Causes**:
  * **Rosetta / x86_64 binary**: An old Intel FFmpeg binary was copied from a previous Mac instead of native arm64.
    ```bash
    file $(which ffmpeg)
    # Expected: Mach-O 64-bit executable arm64
    ```
  * **Missing VideoToolbox**: Custom or non-Homebrew FFmpeg build without `--enable-videotoolbox`.
    ```bash
    ffmpeg -encoders | grep videotoolbox
    # Expected: V..... h264_videotoolbox
    ```
* **Fix**: Reinstall native arm64 FFmpeg via Homebrew:
  ```bash
  brew reinstall ffmpeg
  ```

### 3. Terminal Running Under Rosetta
* **Symptom**: `uname -m` reports `x86_64` instead of `arm64` on Apple Silicon.
* **Root Cause**: Terminal was set to "Open using Rosetta" in Finder Info, which forces all processes into x86 translation and disables Apple Silicon Metal/VideoToolbox direct hardware access.
* **Fix**: In Finder, go to `/Applications/Utilities/Terminal.app` -> Right Click -> "Get Info" -> **Uncheck "Open using Rosetta"**.

### 4. FFmpeg Filter Script Syntax (`-/filter_complex` vs `-filter_complex_script`)
* **Symptom**: `Unrecognized option 'filter_complex_script'` or `Unrecognized option '-/filter_complex'`.
* **Root Cause**: FFmpeg 7+ deprecated `-filter_complex_script` in favor of `-/filter_complex <file>`. FFmpeg 6 and earlier only support `-filter_complex_script`.
* **Status**: Handled automatically in `backend/exporter.py` with seamless fallback between syntax versions.

### 5. Font Path & Traditional Chinese Glyphs
* **Symptom**: Subtitles appear as boxes, or export fails during font loading.
* **Root Cause**: macOS font catalogs differ between major releases (`/System/Library/Fonts/Supplemental/Songti.ttc` vs `/System/Library/Fonts/Songti.ttc`).
* **Fix**: `backend/exporter.py` automatically checks both locations, tests Traditional Chinese character coverage (`你沒有投票權`), and selects TTC Index 2 (Bold) or 7 (Regular).

---

## 5. Standard Environment Rebuild Procedure (for M1)

If the `.venv` on M1 has corrupted packages or was initialized with the wrong Python architecture:

```bash
cd /path/to/werv

# 1. Verify architecture is native Apple Silicon
uname -m
# Must return: arm64

# 2. Clean and re-create virtual environment
rm -rf .venv
python3 -m venv .venv
source .venv/bin/activate

# 3. Upgrade package installer
pip install --upgrade pip setuptools wheel

# 4. Install backend dependencies
pip install -r backend/requirements.txt

# 5. Run the diagnostic suite to verify 100% PASS
python scripts/diagnose.py
```

---

## 6. Quick Cheat Sheet for AI Agents

```bash
# 1. Run all checks
./.venv/bin/python scripts/diagnose.py

# 2. Check recent export failure details
tail -n 60 logs/backend.log

# 3. Verify VideoToolbox hardware encoder
ffmpeg -encoders 2>&1 | grep h264_videotoolbox

# 4. Kill stale instances if port is blocked
lsof -ti :8000 | xargs kill -9 2>/dev/null || true
lsof -ti :5173 | xargs kill -9 2>/dev/null || true
```
