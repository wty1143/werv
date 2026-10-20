#!/usr/bin/env python3
"""
Werv Environment & Pipeline Diagnostic Tool
===========================================
用途：專供開發者與 AI 代理 (Jetski / Antigravity / Claude Code) 快速診斷
不同 Mac 環境（尤其是舊版 macOS 或非標準安裝的電腦）上的相容性與錯誤成因。

支援功能：
1. 檢查 macOS 版本與 Apple Silicon 晶片架構
2. 檢查 Python 版本與依賴套件 (MLX, PyTorch, Silero, Pillow, OpenCC)
3. 測試 MLX 與 Metal GPU 計算加速能力
4. 測試 PyTorch 與 Silero VAD 載入
5. 檢查 FFmpeg 路徑與編碼器 (h264_videotoolbox, libx264, aac)
6. 測試中文字型載入與 Pillow 字元繪製 (宋體、黑體、蘋方)
7. 端到端迷你字幕匯出驗證 (生成 0.5s 測試視訊實測 FFmpeg filter_complex 輸出)
8. 提供結構化 JSON 輸出模式 (--json)，供 AI 代理自動解析並採取修復動作

使用方式：
    ./.venv/bin/python scripts/diagnose.py
    ./.venv/bin/python scripts/diagnose.py --json
    ./.venv/bin/python scripts/diagnose.py --skip-export-test
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple

# 將專案根目錄加入 sys.path 以載入 backend 模組
ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

# ANSI 顏色終端格式化
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


class DiagnosticSuite:
    def __init__(self, skip_export_test: bool = False):
        self.skip_export_test = skip_export_test
        self.results: Dict[str, Any] = {
            "system": {},
            "python": {},
            "packages": {},
            "mlx": {},
            "torch": {},
            "ffmpeg": {},
            "fonts": {},
            "export_test": {},
            "all_passed": True,
            "warnings": [],
            "errors": [],
            "recommendations": [],
        }

    def _log_status(self, category: str, item: str, status: str, detail: str = ""):
        if status == "PASS":
            tag = f"{GREEN}[PASS]{RESET}"
        elif status == "WARN":
            tag = f"{YELLOW}[WARN]{RESET}"
            self.results["warnings"].append(f"{category} -> {item}: {detail}")
        else:
            tag = f"{RED}[FAIL]{RESET}"
            self.results["errors"].append(f"{category} -> {item}: {detail}")
            self.results["all_passed"] = False

        if not getattr(self, "json_mode", False):
            spacing = " " * max(1, 32 - len(item))
            detail_str = f" ({detail})" if detail else ""
            print(f"  {tag} {item}{spacing}{detail_str}")

    def check_system(self):
        mac_ver = platform.mac_ver()[0]
        arch = platform.machine()
        chip = platform.processor()

        self.results["system"] = {
            "macos_version": mac_ver,
            "architecture": arch,
            "processor": chip,
            "uname": platform.uname()._asdict(),
        }

        # 檢查 macOS 版本
        if mac_ver:
            try:
                major, minor = [int(x) for x in mac_ver.split(".")[:2]]
                if major < 13 or (major == 13 and minor < 5):
                    self._log_status(
                        "system",
                        f"macOS 版本: {mac_ver}",
                        "WARN",
                        "macOS 版本低於 13.5 (Ventura)，MLX Metal 硬體加速可能無法編譯，強烈建議升級至 macOS 14+ (Sonoma) 或 15+ (Sequoia)",
                    )
                    self.results["recommendations"].append(
                        "系統升級：目前的 macOS 核心太舊，MLX 與 Metal 運算需要 macOS >= 13.5。請至系統設定檢查 macOS 更新。"
                    )
                else:
                    self._log_status("system", f"macOS 版本: {mac_ver}", "PASS")
            except Exception:
                self._log_status("system", f"macOS 版本: {mac_ver}", "PASS")
        else:
            self._log_status("system", "macOS 平台偵測", "WARN", "非 macOS 或無法讀取版本號")

        # 檢查晶片架構
        if arch == "arm64":
            self._log_status("system", "Apple Silicon 架構 (arm64)", "PASS")
        else:
            self._log_status(
                "system",
                f"架構: {arch}",
                "WARN",
                "偵測到非 arm64 (可能是 Intel Mac 或 Rosetta 轉譯模式)。MLX 僅支援 Apple Silicon 原生 arm64。",
            )
            self.results["recommendations"].append(
                "架構提示：若本機為 Apple Silicon，請勿使用 Rosetta 啟動終端機，需確保在原生 arm64 模式下運行。"
            )

    def check_python_environment(self):
        v = sys.version_info
        py_ver_str = f"{v.major}.{v.minor}.{v.micro}"
        py_bin = sys.executable

        self.results["python"] = {
            "version": py_ver_str,
            "executable": py_bin,
            "is_venv": hasattr(sys, "real_prefix") or (sys.base_prefix != sys.prefix),
        }

        if v.major == 3 and 10 <= v.minor <= 12:
            self._log_status("python", f"Python 版本: {py_ver_str}", "PASS")
        elif v.major == 3 and v.minor >= 13:
            self._log_status(
                "python",
                f"Python 版本: {py_ver_str}",
                "WARN",
                "Python 3.13+ 目前部分 MLX / PyTorch wheel 支援尚不穩定，建議使用 Python 3.10 ~ 3.12",
            )
        else:
            self._log_status(
                "python",
                f"Python 版本: {py_ver_str}",
                "FAIL",
                "Werv 需要 Python 3.10 以上版本",
            )

        if self.results["python"]["is_venv"]:
            self._log_status("python", "虛擬環境 (.venv)", "PASS", py_bin)
        else:
            self._log_status(
                "python",
                "虛擬環境 (.venv)",
                "WARN",
                "未在專用虛擬環境中執行，建議使用專案底下的 ./.venv",
            )

    def check_packages(self):
        pkgs = [
            ("fastapi", "FastAPI"),
            ("uvicorn", "Uvicorn"),
            ("pydantic", "Pydantic"),
            ("PIL", "Pillow (PIL)"),
            ("opencc", "OpenCC"),
            ("soundfile", "SoundFile"),
            ("numpy", "NumPy"),
            ("torch", "PyTorch"),
            ("silero_vad", "Silero VAD"),
            ("mlx", "Apple MLX"),
            ("mlx_whisper", "MLX Whisper"),
        ]

        for mod_name, label in pkgs:
            try:
                mod = __import__(mod_name)
                ver = getattr(mod, "__version__", "installed")
                self.results["packages"][mod_name] = {"status": "PASS", "version": str(ver)}
                self._log_status("packages", f"套件 {label}", "PASS", f"v{ver}")
            except ImportError as e:
                self.results["packages"][mod_name] = {"status": "FAIL", "error": str(e)}
                self._log_status("packages", f"套件 {label}", "FAIL", f"未安裝 ({e})")
                self.results["recommendations"].append(
                    f"安裝缺少套件：請執行 `./.venv/bin/pip install {mod_name}`"
                )

    def check_mlx_metal(self):
        try:
            import mlx.core as mx

            metal_ok = mx.metal.is_available()
            self.results["mlx"]["metal_available"] = metal_ok

            if metal_ok:
                # 測試簡單的 Metal 運算
                a = mx.array([1.0, 2.0, 3.0, 4.0])
                b = (a * 2.0).tolist()
                if b == [2.0, 4.0, 6.0, 8.0]:
                    self._log_status("mlx", "MLX Metal GPU 運算", "PASS")
                    self.results["mlx"]["computation"] = "PASS"
                else:
                    self._log_status("mlx", "MLX Metal GPU 運算", "FAIL", f"計算結果不符: {b}")
                    self.results["mlx"]["computation"] = "FAIL"
            else:
                self._log_status(
                    "mlx",
                    "MLX Metal GPU 運算",
                    "FAIL",
                    "mx.metal.is_available() 回傳 False (舊版 macOS 或不支援 Metal 運算子)",
                )
                self.results["recommendations"].append(
                    "Metal 加速失敗：此台電腦的 macOS 或 GPU 驅動不支援 MLX Metal。請將 macOS 升級至 14+ 或改用相容模式。"
                )
        except Exception as e:
            self.results["mlx"]["error"] = str(e)
            self._log_status("mlx", "MLX 核心檢驗", "FAIL", str(e))

    def check_torch_silero(self):
        try:
            import torch

            mps_ok = torch.backends.mps.is_available()
            self.results["torch"]["mps_available"] = mps_ok
            if mps_ok:
                self._log_status("torch", "PyTorch MPS (Apple GPU)", "PASS")
            else:
                self._log_status("torch", "PyTorch MPS (Apple GPU)", "WARN", "MPS 不可用，將使用 CPU 進行 VAD")

            import silero_vad

            self._log_status("torch", "Silero VAD 語音活動偵測", "PASS")
            self.results["torch"]["silero_status"] = "PASS"
        except Exception as e:
            self.results["torch"]["error"] = str(e)
            self._log_status("torch", "PyTorch / Silero", "FAIL", str(e))

    def check_ffmpeg(self):
        # 尋找 FFmpeg
        try:
            from backend.asr_engine import FFMPEG_BIN, FFPROBE_BIN
        except Exception:
            FFMPEG_BIN = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
            FFPROBE_BIN = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"

        self.results["ffmpeg"]["bin"] = FFMPEG_BIN
        self.results["ffmpeg"]["ffprobe_bin"] = FFPROBE_BIN

        if not os.path.exists(FFMPEG_BIN):
            self._log_status("ffmpeg", "FFmpeg 二進位執行檔", "FAIL", f"找不到 {FFMPEG_BIN}")
            self.results["recommendations"].append(
                "FFmpeg 未安裝：請使用 Homebrew 執行 `brew install ffmpeg`"
            )
            return

        self._log_status("ffmpeg", "FFmpeg 執行檔", "PASS", FFMPEG_BIN)

        # 檢查編碼器支援
        try:
            enc_proc = subprocess.run([FFMPEG_BIN, "-encoders"], capture_output=True, text=True, timeout=5)
            stdout = enc_proc.stdout

            has_vt = "h264_videotoolbox" in stdout
            has_x264 = "libx264" in stdout
            has_aac = "aac" in stdout

            self.results["ffmpeg"]["has_videotoolbox"] = has_vt
            self.results["ffmpeg"]["has_libx264"] = has_x264
            self.results["ffmpeg"]["has_aac"] = has_aac

            if has_vt:
                self._log_status("ffmpeg", "編碼器 h264_videotoolbox (硬體加速)", "PASS")
            else:
                self._log_status(
                    "ffmpeg",
                    "編碼器 h264_videotoolbox (硬體加速)",
                    "WARN",
                    "此 FFmpeg 版本未啟用 videotoolbox 硬體加速，將自動降級至 libx264",
                )

            if has_x264:
                self._log_status("ffmpeg", "編碼器 libx264 (軟體通用備援)", "PASS")
            else:
                self._log_status(
                    "ffmpeg",
                    "編碼器 libx264 (軟體通用備援)",
                    "FAIL",
                    "FFmpeg 缺少 libx264，當 VideoToolbox 失敗時將無備援編碼器可用！",
                )
                self.results["recommendations"].append(
                    "重新安裝完整 FFmpeg：請執行 `brew reinstall ffmpeg` 以獲得完整編碼器支援"
                )

            if has_aac:
                self._log_status("ffmpeg", "音訊編碼器 aac", "PASS")
            else:
                self._log_status("ffmpeg", "音訊編碼器 aac", "FAIL", "缺少 aac 編碼器")

        except Exception as e:
            self._log_status("ffmpeg", "FFmpeg 編碼器檢查", "FAIL", str(e))

    def check_fonts(self):
        try:
            from backend.exporter import load_macos_font

            # 測試常用字型模式
            test_families = ["pingfang", "songti", "heiti", "hiragino"]
            for fam in test_families:
                font = load_macos_font(fam, 36)
                font_name = str(font.getname())
                self.results["fonts"][fam] = {"status": "PASS", "font_name": font_name}
                self._log_status("fonts", f"中文字型載入 ({fam})", "PASS", font_name)

            # 測試以 PIL 繪製中文字型避免缺字 / 破圖
            from PIL import Image, ImageDraw

            img = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            font = load_macos_font("songti", 32)
            draw.text((10, 10), "測試繁體中文：你好宋體！", font=font, fill=(255, 255, 255, 255))
            self._log_status("fonts", "中文字元點陣圖繪製 (Pillow)", "PASS")

        except Exception as e:
            self.results["fonts"]["error"] = str(e)
            self._log_status("fonts", "中文字型或繪製測試", "FAIL", str(e))
            self.results["recommendations"].append(
                f"字型問題：macOS 缺少中文字型或 PIL 繪圖失敗 ({e})。請確認系統字型庫存在 Songti 或 PingFang。"
            )

    def run_mini_export_test(self):
        if self.skip_export_test:
            self._log_status("export_test", "迷你字幕匯出驗證", "PASS", "已略過 (--skip-export-test)")
            return

        try:
            from backend.exporter import export_video_and_srt
            from backend.models import Segment, SubtitleStyle, Token

            FFMPEG_BIN = self.results["ffmpeg"].get("bin") or shutil.which("ffmpeg")
            if not FFMPEG_BIN or not os.path.exists(FFMPEG_BIN):
                self._log_status("export_test", "迷你字幕匯出驗證", "FAIL", "找不到 FFmpeg，無法測試")
                return

            with tempfile.TemporaryDirectory() as tmp_dir:
                tmp_path = Path(tmp_dir)
                test_in = tmp_path / "test_synthetic_in.mp4"
                test_out_mp4 = tmp_path / "test_synthetic_out.mp4"
                test_out_srt = tmp_path / "test_synthetic_out.srt"
                test_out_zip = tmp_path / "test_synthetic_out.zip"

                # 建立 0.5 秒合成短片 (320x240, 藍色畫面 + 靜音)
                gen_cmd = [
                    FFMPEG_BIN,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=0x1E1E2E:s=320x240:d=0.5:r=30",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=stereo",
                    "-t",
                    "0.5",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-c:a",
                    "aac",
                    "-pix_fmt",
                    "yuv420p",
                    str(test_in),
                ]
                gen_proc = subprocess.run(gen_cmd, capture_output=True, text=True, timeout=10)
                if gen_proc.returncode != 0:
                    self._log_status("export_test", "迷你合成短片生成", "FAIL", gen_proc.stderr[-200:])
                    return

                # 測試透過 exporter.py 匯出 (包含字型覆蓋層與雙編碼器 fallback 測試)
                test_segment = Segment(
                    id="seg_diag_001",
                    caption="診斷測試",
                    tokens=[
                        Token(id="tok_001", type="word", text="診斷", start=0.0, end=0.25, deleted=False),
                        Token(id="tok_002", type="word", text="測試", start=0.25, end=0.5, deleted=False),
                    ],
                )

                style = SubtitleStyle(
                    enabled=True,
                    font_family="songti",
                    font_size=48,
                    text_color="#FFFFFF",
                    style_mode="box",
                    box_opacity=0.75,
                    outline_width=3,
                    bottom_offset_pct=8.0,
                )

                export_res = export_video_and_srt(
                    input_video_path=str(test_in),
                    output_mp4_path=str(test_out_mp4),
                    output_srt_path=str(test_out_srt),
                    output_zip_path=str(test_out_zip),
                    segments=[test_segment],
                    total_duration=0.5,
                    subtitle_style=style,
                )

                if test_out_mp4.exists() and test_out_mp4.stat().st_size > 1000:
                    self.results["export_test"]["status"] = "PASS"
                    self.results["export_test"]["exported_size_bytes"] = test_out_mp4.stat().st_size
                    self._log_status("export_test", "迷你端到端字幕合成匯出", "PASS", f"輸出大小: {test_out_mp4.stat().st_size} bytes")
                else:
                    self._log_status("export_test", "迷你端到端字幕合成匯出", "FAIL", "匯出完成但檔案大小為 0 或不存在")

        except Exception as e:
            self.results["export_test"]["error"] = str(e)
            self._log_status("export_test", "迷你端到端字幕合成匯出", "FAIL", str(e))
            self.results["recommendations"].append(
                f"匯出管道出錯：{e}。請檢查 logs/backend.log 查看詳細 FFmpeg 執行指令與錯誤輸出。"
            )

    def run_all(self, json_mode: bool = False) -> Dict[str, Any]:
        self.json_mode = json_mode

        if not json_mode:
            print(f"\n{BOLD}{CYAN}========================================================")
            print("🚀 Werv Studio 環境與字幕渲染管道診斷工具")
            print(f"========================================================{RESET}\n")

            print(f"{BOLD}[1/7] 作業系統與硬體架構{RESET}")
        self.check_system()

        if not json_mode:
            print(f"\n{BOLD}[2/7] Python 環境與虛擬環境{RESET}")
        self.check_python_environment()

        if not json_mode:
            print(f"\n{BOLD}[3/7] 核心相依套件{RESET}")
        self.check_packages()

        if not json_mode:
            print(f"\n{BOLD}[4/7] Apple MLX 與 Metal 加速{RESET}")
        self.check_mlx_metal()

        if not json_mode:
            print(f"\n{BOLD}[5/7] PyTorch 與 Silero VAD 語音活動偵測{RESET}")
        self.check_torch_silero()

        if not json_mode:
            print(f"\n{BOLD}[6/7] FFmpeg 執行檔與編碼器相容性{RESET}")
        self.check_ffmpeg()

        if not json_mode:
            print(f"\n{BOLD}[7/7] 中文字型渲染與端到端匯出驗證{RESET}")
        self.check_fonts()
        self.run_mini_export_test()

        if not json_mode:
            print(f"\n{BOLD}========================================================")
            if self.results["all_passed"] and not self.results["warnings"]:
                print(f"🎉 {GREEN}全數檢測通過！此 Mac 環境完全具備執行 Werv 的最佳條件。{RESET}")
            elif self.results["all_passed"]:
                print(f"⚠️  {YELLOW}檢測通過，但有部分次要警告 (請參考上方 [WARN])。{RESET}")
            else:
                print(f"❌ {RED}偵測到 {len(self.results['errors'])} 項失敗！請參考下方修復建議。{RESET}")

            if self.results["recommendations"]:
                print(f"\n{BOLD}💡 針對此台電腦的具體修復指引：{RESET}")
                for idx, rec in enumerate(self.results["recommendations"], 1):
                    print(f"  {idx}. {rec}")
            print(f"========================================================{RESET}\n")

        return self.results


def main():
    parser = argparse.ArgumentParser(description="Werv 系統與相容性診斷工具")
    parser.add_argument("--json", action="store_true", help="輸出結構化 JSON 供 AI 代理程式 (如 Jetski) 自動解析")
    parser.add_argument("--skip-export-test", action="store_true", help="略過端到端 0.5s 視訊匯出測試")
    args = parser.parse_args()

    if args.json:
        import logging
        from backend.logger import logger as werv_logger
        werv_logger.setLevel(logging.ERROR)
        for h in werv_logger.handlers:
            if isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler):
                h.setLevel(logging.ERROR)

    suite = DiagnosticSuite(skip_export_test=args.skip_export_test)
    results = suite.run_all(json_mode=args.json)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))

    sys.exit(0 if results["all_passed"] else 1)


if __name__ == "__main__":
    main()
