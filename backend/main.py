from contextlib import contextmanager
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .logger import get_logger

from .asr_engine import (
    FFMPEG_BIN,
    probe_video_metadata,
    rebuild_silence_for_segments,
    transcribe_video_file,
)
from .exporter import export_video_and_srt
from .models import (
    CreateSnapshotRequest,
    ExportRequest,
    ExportResponse,
    ProjectMetadata,
    ProjectSnapshot,
    RebuildSilenceRequest,
    SaveProjectStateRequest,
    Segment,
    SnapshotDiffSummary,
    SubtitleStyle,
    TranscribeRequest,
)

BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = BASE_DIR / "storage"
UPLOADS_DIR = STORAGE_DIR / "uploads"
EXPORTS_DIR = STORAGE_DIR / "exports"
PROJECTS_DIR = STORAGE_DIR / "projects"
SNAPSHOTS_DIR = STORAGE_DIR / "snapshots"

for d in (STORAGE_DIR, UPLOADS_DIR, EXPORTS_DIR, PROJECTS_DIR, SNAPSHOTS_DIR):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Werv - Mac 本機端逐字稿剪輯工具 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = get_logger("werv.api")


@app.middleware("http")
async def log_requests_middleware(request: Request, call_next):
    start_time = time.time()
    try:
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        # 避免頻繁 heartbeat 洗版
        if not request.url.path.startswith("/api/heartbeat"):
            logger.info("%s %s -> %s (%.1fms)", request.method, request.url.path, response.status_code, process_time)
        return response
    except Exception as exc:
        process_time = (time.time() - start_time) * 1000
        logger.exception("請求失敗: %s %s (%.1fms): %s", request.method, request.url.path, process_time, exc)
        raise exc

# Mount static directories (Starlette StaticFiles supports HTTP Range requests for video seeking)
app.mount("/media/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount("/media/exports", StaticFiles(directory=str(EXPORTS_DIR)), name="exports")


def _project_json_path(project_id: str) -> Path:
    return PROJECTS_DIR / f"{project_id}.json"


def _save_project(meta: ProjectMetadata) -> None:
    target = _project_json_path(meta.project_id)
    tmp_path = target.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp_path.write_text(meta.model_dump_json(indent=2), encoding="utf-8")
    tmp_path.replace(target)


def _load_project(project_id: str) -> ProjectMetadata:
    p = _project_json_path(project_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"找不到專案 {project_id}")
    content = p.read_text(encoding="utf-8").strip()
    if not content:
        # 自 demo_assets 自癒恢復
        demo_src = BASE_DIR / "demo_assets" / f"{project_id}.json"
        if demo_src.exists():
            content = demo_src.read_text(encoding="utf-8").strip()
            p.write_text(content, encoding="utf-8")
        else:
            raise HTTPException(status_code=500, detail=f"專案檔案為空或損毀: {project_id}")
    return ProjectMetadata.model_validate_json(content)


def _find_video_file(project_id: str) -> Path:
    matches = list(UPLOADS_DIR.glob(f"{project_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail=f"找不到專案影片檔案 {project_id}")
    return matches[0]


def _project_snapshots_dir(project_id: str) -> Path:
    d = SNAPSHOTS_DIR / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _compute_snapshot_summary(
    segments: List[Segment],
    initial_segments: Optional[List[Segment]],
) -> SnapshotDiffSummary:
    total_rows = len(segments)
    init_rows = len(initial_segments) if initial_segments else total_rows
    row_delta = total_rows - init_rows

    del_words = 0
    del_silences = 0
    shortened_silences = 0

    for seg in segments:
        for tok in seg.tokens:
            if tok.type == "word":
                if tok.deleted:
                    del_words += 1
            else:
                if tok.deleted:
                    del_silences += 1
                elif tok.keep_duration is not None and tok.keep_duration > 0:
                    shortened_silences += 1

    modified_details: List[str] = []
    initial_words_map: Dict[str, str] = {}
    if initial_segments:
        for seg in initial_segments:
            for tok in seg.tokens:
                if tok.type == "word":
                    initial_words_map[tok.id] = tok.text

        for seg_idx, seg in enumerate(segments):
            if seg.caption is not None and seg.caption.strip():
                modified_details.append(f"第 {seg_idx + 1} 列自訂字幕：「{seg.caption.strip()[:20]}」")
            for tok in seg.tokens:
                if tok.type == "word" and tok.id in initial_words_map:
                    orig = initial_words_map[tok.id]
                    if orig != tok.text:
                        modified_details.append(f"「{orig}」➔「{tok.text}」")

    return SnapshotDiffSummary(
        total_rows=total_rows,
        initial_rows=init_rows,
        row_delta=row_delta,
        deleted_words=del_words,
        deleted_silences=del_silences,
        shortened_silences=shortened_silences,
        modified_count=len(modified_details),
        modified_details=modified_details[:20],
    )


def _create_snapshot(
    project: ProjectMetadata,
    label: Optional[str] = None,
    trigger: str = "manual",
    segments: Optional[List[Segment]] = None,
    silence_threshold: Optional[float] = None,
    subtitle_style: Optional[SubtitleStyle] = None,
) -> ProjectSnapshot:
    cur_segments = segments if segments is not None else project.segments
    cur_threshold = silence_threshold if silence_threshold is not None else project.silence_threshold
    cur_style = subtitle_style if subtitle_style is not None else (project.subtitle_style or SubtitleStyle())

    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    snap_id = f"snap_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"

    if not label:
        if trigger == "pre_export":
            label = f"匯出前自動備份 ({datetime.now().strftime('%H:%M:%S')})"
        elif trigger == "initial":
            label = "初始辨識基準"
        elif trigger == "auto":
            label = f"自動存檔 ({datetime.now().strftime('%H:%M:%S')})"
        else:
            label = f"手動快照 ({datetime.now().strftime('%H:%M:%S')})"

    summary = _compute_snapshot_summary(cur_segments, project.initial_segments)

    snapshot = ProjectSnapshot(
        snapshot_id=snap_id,
        project_id=project.project_id,
        filename=project.filename,
        label=label,
        trigger=trigger,
        created_at=now_iso,
        silence_threshold=cur_threshold,
        subtitle_style=cur_style,
        segments=cur_segments,
        summary=summary,
    )

    p_dir = _project_snapshots_dir(project.project_id)
    target = p_dir / f"{snap_id}.json"
    target.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")

    # Keep at most 50 snapshots
    snaps = sorted(p_dir.glob("snap_*.json"), key=lambda p: p.stat().st_mtime)
    if len(snaps) > 50:
        for old in snaps[:-50]:
            try:
                old.unlink()
            except Exception:
                pass

    return snapshot


@app.get("/api/health")
def health_check() -> Dict[str, str]:
    return {"status": "ok", "engine": "mlx-whisper + silero-vad + videotoolbox"}


# ==============================================================================
# 瀏覽器分頁心跳與自動退出機制
# 當使用者關閉瀏覽器網頁時，自動結束後端與前端伺服器，免手動關閉終端機
# ==============================================================================
_last_heartbeat_time = time.time()
_has_received_heartbeat = False
_shutdown_timer: Optional[threading.Timer] = None
_shutdown_lock = threading.Lock()
_active_busy_tasks = 0
_busy_lock = threading.Lock()


@contextmanager
def busy_task_scope(task_name: str = "task"):
    """
    保護背景繁重任務（如影片匯出、ASR 辨識、大檔上傳），
    確保在任務執行期間看門狗絕不誤判瀏覽器分頁離開而強制退出。
    """
    global _active_busy_tasks, _last_heartbeat_time
    with _busy_lock:
        _active_busy_tasks += 1
        _last_heartbeat_time = time.time()
        _cancel_shutdown()
    logger.info("進入背景任務保護: %s (目前忙碌任務數: %d)", task_name, _active_busy_tasks)
    try:
        yield
    finally:
        with _busy_lock:
            _active_busy_tasks = max(0, _active_busy_tasks - 1)
            _last_heartbeat_time = time.time()
        logger.info("退出背景任務保護: %s (剩餘忙碌任務數: %d)", task_name, _active_busy_tasks)


def _perform_graceful_shutdown() -> None:
    print("\n========================================================")
    print("👋 [Werv] 偵測到瀏覽器分頁已關閉，正在安全退出前後端服務...")
    print("========================================================\n")
    try:
        os.kill(os.getpid(), signal.SIGINT)
    except Exception:
        os._exit(0)


def _schedule_shutdown(delay: float = 5.0) -> None:
    global _shutdown_timer
    with _shutdown_lock:
        if _shutdown_timer is not None:
            _shutdown_timer.cancel()
        _shutdown_timer = threading.Timer(delay, _perform_graceful_shutdown)
        _shutdown_timer.daemon = True
        _shutdown_timer.start()


def _cancel_shutdown() -> None:
    global _shutdown_timer
    with _shutdown_lock:
        if _shutdown_timer is not None:
            _shutdown_timer.cancel()
            _shutdown_timer = None


def _heartbeat_watchdog() -> None:
    """守門線程：初次收到心跳後，若超過 300 秒毫無心跳（瀏覽器崩潰/強制退出）且無進行中任務，自動退出。"""
    time.sleep(30)
    while True:
        time.sleep(5)
        # 若後端正在匯出、辨識或處理任務，不斷續期心跳，防止背景節能與計時器節流誤殺
        with _busy_lock:
            if _active_busy_tasks > 0:
                global _last_heartbeat_time
                _last_heartbeat_time = time.time()
                continue

        if _has_received_heartbeat:
            elapsed = time.time() - _last_heartbeat_time
            # 提高至 300 秒（5 分鐘），給予背景分頁充足的節能與切換寬限
            if elapsed > 300.0:
                logger.warning("心跳超時（%.1f 秒無心跳），觸發自動安全退出...", elapsed)
                _perform_graceful_shutdown()
                break


_watchdog_thread = threading.Thread(target=_heartbeat_watchdog, daemon=True)
_watchdog_thread.start()


@app.post("/api/heartbeat")
def heartbeat() -> Dict[str, str]:
    global _last_heartbeat_time, _has_received_heartbeat
    _last_heartbeat_time = time.time()
    _has_received_heartbeat = True
    _cancel_shutdown()
    return {"status": "alive"}


@app.post("/api/heartbeat/leave")
def heartbeat_leave() -> Dict[str, str]:
    # 收到分頁關閉信號（來自 pagehide / beforeunload 的 sendBeacon）
    with _busy_lock:
        if _active_busy_tasks > 0:
            logger.info("收到分頁離開信號，但目前有 %d 個後端任務進行中，延後自動關閉", _active_busy_tasks)
            return {"status": "busy_deferred"}

    # 給予 5 秒緩衝（防止使用者只是按了 F5/⌘R 重新整理頁面）
    _schedule_shutdown(delay=5.0)
    return {"status": "scheduled_shutdown"}


@app.post("/api/upload", response_model=ProjectMetadata)
async def upload_video(file: UploadFile = File(...)) -> ProjectMetadata:
    with busy_task_scope(f"upload_{file.filename or 'video'}"):
        project_id = f"proj_{uuid.uuid4().hex[:10]}"
        orig_name = file.filename or "video.mp4"
        ext = Path(orig_name).suffix.lower() or ".mp4"
        dest_path = UPLOADS_DIR / f"{project_id}{ext}"

        with dest_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        meta_info = probe_video_metadata(str(dest_path))
        project = ProjectMetadata(
            project_id=project_id,
            filename=orig_name,
            video_url=f"/media/uploads/{dest_path.name}",
            duration=meta_info["duration"],
            width=meta_info["width"],
            height=meta_info["height"],
            fps=meta_info["fps"],
            segments=[],
        )
        _save_project(project)
        return project


@app.post("/api/transcribe", response_model=ProjectMetadata)
def transcribe_project(req: TranscribeRequest) -> ProjectMetadata:
    with busy_task_scope(f"transcribe_{req.project_id}"):
        project = _load_project(req.project_id)
        video_path = _find_video_file(req.project_id)

        segments, vad_intervals = transcribe_video_file(
            video_path=str(video_path),
            model_name=req.model_name,
            custom_prompt=req.custom_prompt,
            silence_threshold=req.silence_threshold,
            total_duration=project.duration,
            return_vad=True,
        )

        import copy
        project.model_name = req.model_name
        project.custom_prompt = req.custom_prompt
        project.silence_threshold = req.silence_threshold
        project.segments = segments
        project.initial_segments = copy.deepcopy(segments)
        project.vad_intervals = vad_intervals
        project.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _save_project(project)

        try:
            _create_snapshot(project=project, trigger="initial", label="初始語音辨識基準")
        except Exception as e:
            logger.warning("建立初始快照失敗: %s", e)

        return project


@app.post("/api/rebuild-silence")
def rebuild_silence(req: RebuildSilenceRequest):
    with busy_task_scope(f"rebuild_silence_{req.project_id or 'adhoc'}"):
        vad_intervals = req.vad_intervals
        if not vad_intervals and req.project_id:
            try:
                proj = _load_project(req.project_id)
                vad_intervals = proj.vad_intervals
            except Exception:
                pass

        updated = rebuild_silence_for_segments(
            segments=req.segments,
            silence_threshold=req.silence_threshold,
            total_duration=req.duration,
            vad_intervals=vad_intervals,
        )
        return {"segments": updated}


@app.get("/api/projects/{project_id}", response_model=ProjectMetadata)
def get_project(project_id: str) -> ProjectMetadata:
    return _load_project(project_id)


@app.put("/api/projects/{project_id}/state", response_model=ProjectMetadata)
def save_project_state(project_id: str, req: SaveProjectStateRequest) -> ProjectMetadata:
    project = _load_project(project_id)
    project.segments = req.segments
    if req.silence_threshold is not None:
        project.silence_threshold = req.silence_threshold
    if req.subtitle_style is not None:
        project.subtitle_style = req.subtitle_style
    project.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _save_project(project)
    return project


@app.get("/api/projects")
def list_projects():
    """列出本機所有影片專案，供前端選單隨時切換與恢復。"""
    results = []
    for p in sorted(PROJECTS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            content = p.read_text(encoding="utf-8").strip()
            if not content:
                continue
            meta = ProjectMetadata.model_validate_json(content)
            results.append({
                "project_id": meta.project_id,
                "filename": meta.filename,
                "duration": meta.duration,
                "segment_count": len(meta.segments),
                "updated_at": meta.updated_at or datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            })
        except Exception:
            continue
    return results


@app.post("/api/projects/{project_id}/snapshots", response_model=ProjectSnapshot)
def create_snapshot_endpoint(project_id: str, req: CreateSnapshotRequest) -> ProjectSnapshot:
    project = _load_project(project_id)
    project.segments = req.segments
    project.silence_threshold = req.silence_threshold
    if req.subtitle_style is not None:
        project.subtitle_style = req.subtitle_style
    project.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _save_project(project)

    return _create_snapshot(
        project=project,
        label=req.label,
        trigger=req.trigger,
        segments=req.segments,
        silence_threshold=req.silence_threshold,
        subtitle_style=req.subtitle_style,
    )


@app.get("/api/projects/{project_id}/snapshots", response_model=List[ProjectSnapshot])
def list_snapshots_endpoint(project_id: str) -> List[ProjectSnapshot]:
    p_dir = _project_snapshots_dir(project_id)
    results: List[ProjectSnapshot] = []
    for snap_file in sorted(p_dir.glob("snap_*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = snap_file.read_text(encoding="utf-8")
            results.append(ProjectSnapshot.model_validate_json(data))
        except Exception as e:
            logger.warning("無法載入快照 %s: %s", snap_file.name, e)
            continue
    return results


@app.post("/api/projects/{project_id}/snapshots/{snapshot_id}/restore", response_model=ProjectMetadata)
def restore_snapshot_endpoint(project_id: str, snapshot_id: str) -> ProjectMetadata:
    p_dir = _project_snapshots_dir(project_id)
    target = p_dir / f"{snapshot_id}.json"
    if not target.exists():
        raise HTTPException(status_code=404, detail="找不到指定快照")

    snap = ProjectSnapshot.model_validate_json(target.read_text(encoding="utf-8"))
    project = _load_project(project_id)

    # 在還原之前，先自動為當前狀態備份一筆
    try:
        _create_snapshot(project=project, label=f"還原前自動備份 ({datetime.now().strftime('%H:%M:%S')})", trigger="auto")
    except Exception:
        pass

    project.segments = snap.segments
    project.silence_threshold = snap.silence_threshold
    project.subtitle_style = snap.subtitle_style
    project.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _save_project(project)
    return project


@app.delete("/api/projects/{project_id}/snapshots/{snapshot_id}")
def delete_snapshot_endpoint(project_id: str, snapshot_id: str):
    p_dir = _project_snapshots_dir(project_id)
    target = p_dir / f"{snapshot_id}.json"
    if target.exists():
        target.unlink()
        return {"status": "deleted", "snapshot_id": snapshot_id}
    raise HTTPException(status_code=404, detail="找不到指定快照")


@app.post("/api/export", response_model=ExportResponse)
def export_project(req: ExportRequest) -> ExportResponse:
    with busy_task_scope(f"export_{req.project_id}"):
        project = _load_project(req.project_id)
        video_path = _find_video_file(req.project_id)

        export_id = f"exp_{uuid.uuid4().hex[:8]}"
        stem = Path(project.filename).stem
        safe_stem = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in stem) or "werv_cut"

        mp4_name = f"{safe_stem}_{export_id}.mp4"
        srt_name = f"{safe_stem}_{export_id}.srt"
        zip_name = f"{safe_stem}_{export_id}_bundle.zip"

        mp4_path = EXPORTS_DIR / mp4_name
        srt_path = EXPORTS_DIR / srt_name
        zip_path = EXPORTS_DIR / zip_name

        logger.info(
            "開始匯出影片: project_id=%s, input=%s, segments=%d, subtitle_enabled=%s, style=%s",
            req.project_id,
            video_path.name,
            len(req.segments),
            req.subtitle_style.enabled,
            req.subtitle_style.style_mode,
        )

        # 1. 執行 FFmpeg 前先完整存檔並自動建立匯出前快照，確保即使匯出中斷也不會遺失任何換行或改字
        project.segments = req.segments
        project.subtitle_style = req.subtitle_style
        project.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _save_project(project)
        try:
            _create_snapshot(project=project, trigger="pre_export")
        except Exception as e:
            logger.warning("建立匯出前快照失敗 (不中斷匯出): %s", e)

        try:
            res = export_video_and_srt(
                input_video_path=str(video_path),
                output_mp4_path=str(mp4_path),
                output_srt_path=str(srt_path),
                output_zip_path=str(zip_path),
                segments=req.segments,
                padding=req.padding,
                merge_gap=req.merge_gap,
                fade_ms=req.fade_ms,
                total_duration=project.duration,
                subtitle_style=req.subtitle_style,
            )
            logger.info("影片匯出成功: %s, 導出長度=%.2fs, 節省=%.2fs", mp4_name, res["exported_duration"], res["saved_seconds"])
        except ValueError as e:
            logger.warning("匯出參數錯誤: %s", e)
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.exception("匯出處理發生例外錯誤: %s", e)
            raise HTTPException(status_code=500, detail=str(e))

        return ExportResponse(
            export_id=export_id,
            mp4_url=f"/media/exports/{mp4_name}",
            download_url=f"/api/download/{mp4_name}",
            filename=mp4_name,
            srt_url=f"/media/exports/{srt_name}",
            bundle_url=f"/media/exports/{zip_name}",
            srt_content=res["srt_content"],
            keep_ranges=res["keep_ranges"],
            original_duration=res["original_duration"],
            exported_duration=res["exported_duration"],
            saved_seconds=res["saved_seconds"],
            cut_count=res["cut_count"],
        )


@app.get("/api/download/{filename}")
def download_export_file(filename: str):
    """
    透過 Content-Disposition: attachment 提供直接下載，
    避免瀏覽器在當前頁籤直接導航播放影片而中斷編輯狀態或觸發 heartbeat_leave。
    """
    safe_filename = Path(filename).name
    file_path = EXPORTS_DIR / safe_filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="檔案不存在或尚未產生")
    return FileResponse(
        path=str(file_path),
        filename=safe_filename,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
    )


@app.post("/api/export/reveal/{filename}")
def reveal_in_finder(filename: str):
    """
    在 macOS Finder 中直接標記定位剛匯出的檔案
    """
    safe_filename = Path(filename).name
    file_path = EXPORTS_DIR / safe_filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="檔案不存在")
    try:
        subprocess.run(["open", "-R", str(file_path)], check=True)
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"無法在 Finder 中開啟: {e}")


@app.post("/api/export/open/{filename}")
def open_in_default_player(filename: str):
    """
    在 macOS 預設播放器 (如 QuickTime Player, IINA) 中直接播放剛匯出的成品影片
    """
    safe_filename = Path(filename).name
    file_path = EXPORTS_DIR / safe_filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="檔案不存在")
    try:
        subprocess.run(["open", str(file_path)], check=True)
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"無法開啟檔案: {e}")


@app.get("/api/system/logs")
def get_system_logs(lines: int = 200):
    """
    取得後端最近日誌 (預設 200 行)，供前端除錯面板或 AI agent 檢查環境錯誤
    """
    from .logger import LOG_FILE
    if not LOG_FILE.exists():
        return {"logs": "(尚無日誌檔案，服務可能剛啟動)", "log_file": str(LOG_FILE), "total_lines": 0}
    try:
        content = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
        tail = content[-max(1, min(lines, 2000)):]
        return {
            "logs": "\n".join(tail),
            "total_lines": len(content),
            "log_file": str(LOG_FILE),
        }
    except Exception as e:
        return {"error": str(e), "log_file": str(LOG_FILE)}


@app.get("/api/system/diagnostics")
def get_system_diagnostics():
    """
    執行輕量自我診斷，供 AI agent (如 Jetski) 或開發者掌握另一台電腦的環境相容性
    """
    import platform
    import sys
    from .asr_engine import FFMPEG_BIN, FFPROBE_BIN

    report = {
        "os_version": platform.mac_ver()[0] or platform.platform(),
        "arch": platform.machine(),
        "python_version": sys.version,
        "python_bin": sys.executable,
        "ffmpeg_bin": FFMPEG_BIN,
        "ffprobe_bin": FFPROBE_BIN,
        "ffmpeg_exists": os.path.exists(FFMPEG_BIN),
    }

    # 1. 測試 MLX 與 Metal 加速
    try:
        import mlx.core as mx
        a = mx.array([1, 2, 3])
        _ = (a * 2).tolist()
        report["mlx_metal_status"] = "OK"
        report["mlx_version"] = getattr(mx, "__version__", "installed")
    except Exception as e:
        report["mlx_metal_status"] = f"FAIL: {e}"

    # 2. 測試 PyTorch 與 Silero VAD
    try:
        import torch
        import silero_vad
        report["torch_status"] = "OK"
        report["torch_version"] = torch.__version__
        report["mps_available"] = torch.backends.mps.is_available()
    except Exception as e:
        report["torch_status"] = f"FAIL: {e}"

    # 3. 測試 FFmpeg 編碼器支援
    try:
        enc_res = subprocess.run([FFMPEG_BIN, "-encoders"], capture_output=True, text=True, timeout=3)
        report["has_videotoolbox"] = "h264_videotoolbox" in enc_res.stdout
    except Exception as e:
        report["ffmpeg_check_error"] = str(e)

    # 4. 測試字型載入
    try:
        from .exporter import load_macos_font
        font = load_macos_font("songti", 48)
        report["songti_font"] = str(font.getname())
    except Exception as e:
        report["font_load_error"] = str(e)

    return report


@app.post("/api/demo", response_model=ProjectMetadata)
def create_demo_project(
    transcribe: bool = True,
    force: bool = False,
    model_name: str = "mlx-community/whisper-large-v3-turbo",
) -> ProjectMetadata:
    """
    Generate a sample Taiwanese Mandarin video with deliberate speech pauses (0.7s ~ 1.0s)
    using macOS speech synthesis + FFmpeg VideoToolbox, then optionally run ASR on it.
    """
    project_id = "proj_demo_sample"
    dest_mp4 = UPLOADS_DIR / f"{project_id}.mp4"
    json_path = _project_json_path(project_id)
    demo_assets_dir = BASE_DIR / "demo_assets"

    # 若 storage 還沒有範例檔案，優先從倉庫隨附的 demo_assets 複製，達到零秒載入
    if not dest_mp4.exists() and (demo_assets_dir / f"{project_id}.mp4").exists():
        dest_mp4.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(demo_assets_dir / f"{project_id}.mp4", dest_mp4)

    if not json_path.exists() and (demo_assets_dir / f"{project_id}.json").exists():
        json_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(demo_assets_dir / f"{project_id}.json", json_path)

    if not force and dest_mp4.exists() and json_path.exists():
        try:
            cached = _load_project(project_id)
            if cached.segments:
                # 記憶體內重置刪除狀態，免重複寫入硬碟避免並發競態
                for seg in cached.segments:
                    for tok in seg.tokens:
                        tok.deleted = False
                        tok.keep_duration = None
                if not cached.initial_segments and cached.segments:
                    import copy
                    cached.initial_segments = copy.deepcopy(cached.segments)
                    _save_project(cached)
                return cached
        except Exception:
            # 檔案損毀時自動從 demo_assets 覆蓋修復
            demo_json = demo_assets_dir / f"{project_id}.json"
            if demo_json.exists():
                shutil.copy2(demo_json, json_path)
                return _load_project(project_id)

    if not dest_mp4.exists():
        _generate_sample_mandarin_video(str(dest_mp4))

    meta_info = probe_video_metadata(str(dest_mp4))
    project = ProjectMetadata(
        project_id=project_id,
        filename="Werv_台灣繁中測試短片.mp4",
        video_url=f"/media/uploads/{dest_mp4.name}",
        duration=meta_info["duration"],
        width=meta_info["width"],
        height=meta_info["height"],
        fps=meta_info["fps"],
        model_name=model_name,
        custom_prompt="Werv, Vrew, 剪映, Apple Silicon, 氣口",
        silence_threshold=0.4,
        segments=[],
    )

    if transcribe:
        project.segments, project.vad_intervals = transcribe_video_file(
            video_path=str(dest_mp4),
            model_name=model_name,
            custom_prompt=project.custom_prompt,
            silence_threshold=0.4,
            total_duration=project.duration,
            return_vad=True,
        )
        import copy
        project.initial_segments = copy.deepcopy(project.segments)
        project.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    _save_project(project)
    if transcribe and project.segments:
        try:
            _create_snapshot(project=project, trigger="initial", label="初始範例辨識基準")
        except Exception:
            pass
    return project


def _generate_sample_mandarin_video(output_mp4_path: str) -> None:
    """Create a realistic spoken Taiwanese Mandarin test video with pauses between sentences."""
    phrases = [
        "大家好，歡迎使用這套跑在蘋果電腦上的逐字稿剪輯軟體。",
        "只要在畫面上選取多餘的贅字或是空白氣口，按下空白鍵就能直接剪掉片段。",
        "最後一鍵匯出硬體加速的影片與重算時間軸的字幕檔，就能直接放進剪映做後製。",
    ]
    with tempfile.TemporaryDirectory() as tmpdir:
        part_wavs = []
        silence_wav = os.path.join(tmpdir, "pause.wav")
        subprocess.run(
            [
                FFMPEG_BIN,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=22050:cl=mono",
                "-t",
                "0.75",
                silence_wav,
            ],
            capture_output=True,
            check=True,
        )

        for idx, text in enumerate(phrases):
            aiff_path = os.path.join(tmpdir, f"p_{idx}.aiff")
            wav_path = os.path.join(tmpdir, f"p_{idx}.wav")
            # Try Meijia (Taiwanese Mandarin) first, fallback to default system Chinese voice
            res = subprocess.run(
                ["say", "-v", "Meijia", "-r", "195", "-o", aiff_path, text],
                capture_output=True,
            )
            if res.returncode != 0:
                subprocess.run(["say", "-o", aiff_path, text], capture_output=True, check=True)

            subprocess.run(
                [FFMPEG_BIN, "-y", "-i", aiff_path, "-ar", "22050", "-ac", "1", wav_path],
                capture_output=True,
                check=True,
            )
            part_wavs.append(wav_path)
            part_wavs.append(silence_wav)

        concat_list = os.path.join(tmpdir, "concat.txt")
        with open(concat_list, "w", encoding="utf-8") as f:
            for w in part_wavs:
                f.write(f"file '{w}'\n")

        full_wav = os.path.join(tmpdir, "full.wav")
        subprocess.run(
            [FFMPEG_BIN, "-y", "-f", "concat", "-safe", "0", "-i", concat_list, "-c", "copy", full_wav],
            capture_output=True,
            check=True,
        )

        # Render a sleek 1280x720 30fps test video with visual time counter & audio waveform
        subprocess.run(
            [
                FFMPEG_BIN,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x161925:s=1280x720:r=30",
                "-i",
                full_wav,
                "-filter_complex",
                "[1:a]showwaves=s=1280x240:mode=cline:rate=30:colors=0x38bdf8|0x818cf8[wf];"
                "[0:v][wf]overlay=0:240:shortest=1[outv]",
                "-map",
                "[outv]",
                "-map",
                "1:a",
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                "8M",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                output_mp4_path,
            ],
            capture_output=True,
            check=True,
        )
