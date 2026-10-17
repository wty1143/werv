import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .asr_engine import (
    FFMPEG_BIN,
    probe_video_metadata,
    rebuild_silence_for_segments,
    transcribe_video_file,
)
from .exporter import export_video_and_srt
from .models import (
    ExportRequest,
    ExportResponse,
    ProjectMetadata,
    RebuildSilenceRequest,
    TranscribeRequest,
)

BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = BASE_DIR / "storage"
UPLOADS_DIR = STORAGE_DIR / "uploads"
EXPORTS_DIR = STORAGE_DIR / "exports"
PROJECTS_DIR = STORAGE_DIR / "projects"

for d in (STORAGE_DIR, UPLOADS_DIR, EXPORTS_DIR, PROJECTS_DIR):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Werv - Mac 本機端逐字稿剪輯工具 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static directories (Starlette StaticFiles supports HTTP Range requests for video seeking)
app.mount("/media/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount("/media/exports", StaticFiles(directory=str(EXPORTS_DIR)), name="exports")


def _project_json_path(project_id: str) -> Path:
    return PROJECTS_DIR / f"{project_id}.json"


def _save_project(meta: ProjectMetadata) -> None:
    _project_json_path(meta.project_id).write_text(
        meta.model_dump_json(indent=2), encoding="utf-8"
    )


def _load_project(project_id: str) -> ProjectMetadata:
    p = _project_json_path(project_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"找不到專案 {project_id}")
    return ProjectMetadata.model_validate_json(p.read_text(encoding="utf-8"))


def _find_video_file(project_id: str) -> Path:
    matches = list(UPLOADS_DIR.glob(f"{project_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail=f"找不到專案影片檔案 {project_id}")
    return matches[0]


@app.get("/api/health")
def health_check() -> Dict[str, str]:
    return {"status": "ok", "engine": "mlx-whisper + silero-vad + videotoolbox"}


@app.post("/api/upload", response_model=ProjectMetadata)
async def upload_video(file: UploadFile = File(...)) -> ProjectMetadata:
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

    project.model_name = req.model_name
    project.custom_prompt = req.custom_prompt
    project.silence_threshold = req.silence_threshold
    project.segments = segments
    project.vad_intervals = vad_intervals
    _save_project(project)
    return project


@app.post("/api/rebuild-silence")
def rebuild_silence(req: RebuildSilenceRequest):
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


@app.post("/api/export", response_model=ExportResponse)
def export_project(req: ExportRequest) -> ExportResponse:
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
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Persist latest edited segments
    project.segments = req.segments
    _save_project(project)

    return ExportResponse(
        export_id=export_id,
        mp4_url=f"/media/exports/{mp4_name}",
        srt_url=f"/media/exports/{srt_name}",
        bundle_url=f"/media/exports/{zip_name}",
        srt_content=res["srt_content"],
        keep_ranges=res["keep_ranges"],
        original_duration=res["original_duration"],
        exported_duration=res["exported_duration"],
        saved_seconds=res["saved_seconds"],
        cut_count=res["cut_count"],
    )


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

    if not force and dest_mp4.exists() and json_path.exists():
        cached = _load_project(project_id)
        if cached.segments:
            for seg in cached.segments:
                for tok in seg.tokens:
                    tok.deleted = False
            _save_project(cached)
            return cached

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

    _save_project(project)
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
