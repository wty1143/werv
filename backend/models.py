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
    caption: Optional[str] = None


class KeepRange(BaseModel):
    start: float
    end: float


class SubtitleStyle(BaseModel):
    enabled: bool = True
    font_family: Literal["pingfang", "heiti", "songti", "hiragino"] = "pingfang"
    font_size: int = 48  # 基於 1080p 高度的參考字號 (28 ~ 84)
    text_color: str = "#FFFFFF"
    style_mode: Literal["box", "outline", "shadow"] = "box"
    box_opacity: float = 0.75  # 半透明底框不透明度
    outline_width: int = 3     # 描邊粗細
    bottom_offset_pct: float = 8.0  # 距離畫面底部百分比 (3.0 ~ 85.0)


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
    initial_segments: Optional[List[Segment]] = None
    subtitle_style: Optional[SubtitleStyle] = None
    vad_intervals: Optional[List[dict]] = None
    updated_at: Optional[str] = None


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


class SaveProjectStateRequest(BaseModel):
    segments: List[Segment]
    silence_threshold: Optional[float] = None
    subtitle_style: Optional[SubtitleStyle] = None


class SnapshotDiffSummary(BaseModel):
    total_rows: int
    initial_rows: int
    row_delta: int
    deleted_words: int
    deleted_silences: int
    shortened_silences: int
    modified_count: int
    modified_details: List[str] = Field(default_factory=list)


class ProjectSnapshot(BaseModel):
    snapshot_id: str
    project_id: str
    filename: str
    label: str
    trigger: Literal["manual", "pre_export", "auto", "initial"] = "manual"
    created_at: str
    silence_threshold: float = 0.4
    subtitle_style: SubtitleStyle = Field(default_factory=SubtitleStyle)
    segments: List[Segment] = Field(default_factory=list)
    summary: SnapshotDiffSummary


class CreateSnapshotRequest(BaseModel):
    label: Optional[str] = None
    trigger: Literal["manual", "pre_export", "auto", "initial"] = "manual"
    segments: List[Segment]
    silence_threshold: float = 0.4
    subtitle_style: Optional[SubtitleStyle] = None


class ExportRequest(BaseModel):
    project_id: str
    segments: List[Segment]
    padding: float = 0.05
    merge_gap: float = 0.08
    fade_ms: float = 15.0
    subtitle_style: SubtitleStyle = Field(default_factory=SubtitleStyle)


class ExportResponse(BaseModel):
    export_id: str
    mp4_url: str
    download_url: str
    filename: str
    srt_url: str = ""
    bundle_url: str = ""
    srt_content: str = ""
    keep_ranges: List[KeepRange]
    original_duration: float
    exported_duration: float
    saved_seconds: float
    cut_count: int
