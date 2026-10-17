from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class Token(BaseModel):
    id: str
    type: Literal["word", "silence"]
    text: str
    start: float
    end: float
    deleted: bool = False
    keep_duration: Optional[float] = None


class Segment(BaseModel):
    id: str
    tokens: List[Token]


class KeepRange(BaseModel):
    start: float
    end: float


class ProjectMetadata(BaseModel):
    project_id: str
    filename: str
    video_url: str
    duration: float
    width: int = 1920
    height: int = 1080
    fps: float = 30.0
    model_name: str = "mlx-community/whisper-large-v3-turbo"
    custom_prompt: str = ""
    silence_threshold: float = 0.4
    segments: List[Segment] = Field(default_factory=list)
    vad_intervals: Optional[List[dict]] = None


class TranscribeRequest(BaseModel):
    project_id: str
    model_name: Literal[
        "mlx-community/whisper-large-v3",
        "mlx-community/whisper-large-v3-turbo",
    ] = "mlx-community/whisper-large-v3-turbo"
    custom_prompt: str = ""
    silence_threshold: float = 0.4


class RebuildSilenceRequest(BaseModel):
    segments: List[Segment]
    silence_threshold: float = 0.4
    duration: Optional[float] = None
    project_id: Optional[str] = None
    vad_intervals: Optional[List[dict]] = None


class ExportRequest(BaseModel):
    project_id: str
    segments: List[Segment]
    padding: float = 0.05
    merge_gap: float = 0.08
    fade_ms: float = 15.0


class ExportResponse(BaseModel):
    export_id: str
    mp4_url: str
    srt_url: str
    bundle_url: str
    srt_content: str
    keep_ranges: List[KeepRange]
    original_duration: float
    exported_duration: float
    saved_seconds: float
    cut_count: int
