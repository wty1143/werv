import os
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import List, Optional

from .asr_engine import FFMPEG_BIN
from .models import KeepRange, Segment, Token

_ASCII_WORD_RE = re.compile(r"^[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?$")


def compute_keep_ranges(
    segments: List[Segment],
    padding: float = 0.05,
    merge_gap: float = 0.08,
    total_duration: Optional[float] = None,
) -> List[KeepRange]:
    """
    Module C / D Interval Merging Algorithm:
    1. Take all tokens with deleted = False.
    2. Pad each interval by `padding` (default 0.05s) on both ends.
    3. Merge overlapping intervals or adjacent intervals within `merge_gap` (default 0.08s).
    """
    pre_padding = max(padding, 0.08)
    post_padding = max(padding, 0.05)
    raw_intervals: List[List[float]] = []
    for seg in segments:
        for tok in seg.tokens:
            if not tok.deleted:
                s = max(0.0, tok.start - pre_padding)
                e = tok.end + post_padding
                if total_duration is not None and total_duration > 0:
                    e = min(total_duration, e)
                if e > s:
                    raw_intervals.append([s, e])

    if not raw_intervals:
        return []

    raw_intervals.sort(key=lambda x: (x[0], x[1]))
    merged: List[List[float]] = [raw_intervals[0]]

    for curr_s, curr_e in raw_intervals[1:]:
        prev_s, prev_e = merged[-1]
        if curr_s - prev_e <= merge_gap + 1e-6:
            merged[-1][1] = max(prev_e, curr_e)
        else:
            merged.append([curr_s, curr_e])

    return [KeepRange(start=round(s, 3), end=round(e, 3)) for s, e in merged if e - s >= 0.02]


def remap_timestamp(orig_time: float, keep_ranges: List[KeepRange]) -> float:
    """
    Map an original video timestamp `orig_time` onto the new concatenated timeline
    by accumulating kept durations prior to `orig_time`.
    """
    accum = 0.0
    for r in keep_ranges:
        if orig_time <= r.start:
            break
        accum += max(0.0, min(orig_time, r.end) - r.start)
        if orig_time <= r.end:
            break
    return round(accum, 3)


def format_srt_timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    total_ms = int(round(seconds * 1000))
    hours = total_ms // 3_600_000
    rem = total_ms % 3_600_000
    minutes = rem // 60_000
    rem = rem % 60_000
    secs = rem // 1000
    millis = rem % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def join_tokens_text(tokens: List[Token]) -> str:
    """Join word tokens cleanly, inserting a space only between two contiguous ASCII words."""
    if not tokens:
        return ""
    parts: List[str] = []
    for i, tok in enumerate(tokens):
        t = tok.text.strip()
        if not t:
            continue
        if i > 0 and parts:
            prev_t = tokens[i - 1].text.strip()
            if _ASCII_WORD_RE.match(prev_t) and _ASCII_WORD_RE.match(t):
                parts.append(" ")
        parts.append(t)
    return "".join(parts)


def generate_remapped_srt(segments: List[Segment], keep_ranges: List[KeepRange]) -> str:
    """
    Module D SRT Timestamp Remapping:
    Recalculate cumulative timestamps in the exported video for each non-empty subtitle row.
    """
    if not keep_ranges:
        return ""

    srt_blocks: List[str] = []
    subtitle_idx = 1

    for seg in segments:
        kept_words = [t for t in seg.tokens if not t.deleted and t.type == "word" and t.text.strip()]
        if not kept_words:
            continue

        line_text = join_tokens_text(kept_words)
        if not line_text:
            continue

        orig_start = kept_words[0].start
        orig_end = kept_words[-1].end

        new_start = remap_timestamp(orig_start, keep_ranges)
        new_end = remap_timestamp(orig_end, keep_ranges)
        if new_end <= new_start + 0.04:
            new_end = round(new_start + 0.08, 3)

        start_str = format_srt_timestamp(new_start)
        end_str = format_srt_timestamp(new_end)
        srt_blocks.append(f"{subtitle_idx}\n{start_str} --> {end_str}\n{line_text}\n")
        subtitle_idx += 1

    return "\n".join(srt_blocks)


def build_filter_complex(keep_ranges: List[KeepRange], fade_sec: float = 0.015) -> str:
    """
    Build FFmpeg filter_complex graph using `trim` and `atrim` for each range,
    with 15ms audio fade-in/fade-out at cut points to prevent Audio Pop while
    maintaining exact A/V sync across arbitrary cut counts.
    """
    lines: List[str] = []
    concat_inputs: List[str] = []
    n = len(keep_ranges)

    for i, r in enumerate(keep_ranges):
        s = f"{r.start:.4f}"
        e = f"{r.end:.4f}"
        dur = max(0.02, r.end - r.start)

        lines.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}];")

        # Apply 15ms afade at cut boundaries to prevent zero-crossing audio pops
        afade_parts: List[str] = []
        if dur > fade_sec * 2.5:
            fade_out_st = max(0.0, dur - fade_sec)
            afade_parts.append(f"afade=t=in:st=0:d={fade_sec:.4f}")
            afade_parts.append(f"afade=t=out:st={fade_out_st:.4f}:d={fade_sec:.4f}")

        afade_chain = ("," + ",".join(afade_parts)) if afade_parts else ""
        lines.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS{afade_chain}[a{i}];")
        concat_inputs.append(f"[v{i}][a{i}]")

    concat_str = "".join(concat_inputs) + f"concat=n={n}:v=1:a=1[outv][outa]"
    lines.append(concat_str)
    return "\n".join(lines)


def export_video_and_srt(
    input_video_path: str,
    output_mp4_path: str,
    output_srt_path: str,
    output_zip_path: str,
    segments: List[Segment],
    padding: float = 0.05,
    merge_gap: float = 0.08,
    fade_ms: float = 15.0,
    total_duration: Optional[float] = None,
) -> dict:
    """
    Module D Hardware-Accelerated Export:
    - Computes keep_ranges
    - Generates filter_complex (uses -filter_complex_script when > 50 ranges or always for safety)
    - Encodes with Apple VideoToolbox: -c:v h264_videotoolbox -b:v 15M -pix_fmt yuv420p -c:a aac -b:a 192k
    - Writes UTF-8 .srt and bundles both into a .zip archive
    """
    keep_ranges = compute_keep_ranges(
        segments=segments,
        padding=padding,
        merge_gap=merge_gap,
        total_duration=total_duration,
    )
    if not keep_ranges:
        raise ValueError("無法匯出：所有片段皆已被刪除，請至少保留一個字元或片段。")

    fade_sec = max(0.005, fade_ms / 1000.0)
    filter_graph = build_filter_complex(keep_ranges, fade_sec=fade_sec)

    # When kept segments > 50, write filter_complex to a temporary script file to avoid OS arg length limits.
    # Supports both FFmpeg 7+/9 `-/filter_complex <file>` and legacy FFmpeg 5/6 `-filter_complex_script <file>`.
    with tempfile.NamedTemporaryFile("w", suffix=".filter", delete=False, encoding="utf-8") as f_script:
        f_script.write(filter_graph)
        script_path = f_script.name

    def _build_cmd(filter_flag: str, filter_val: str) -> List[str]:
        return [
            FFMPEG_BIN,
            "-y",
            "-i",
            input_video_path,
            filter_flag,
            filter_val,
            "-map",
            "[outv]",
            "-map",
            "[outa]",
            "-c:v",
            "h264_videotoolbox",
            "-b:v",
            "15M",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            output_mp4_path,
        ]

    try:
        if len(keep_ranges) > 50:
            proc = subprocess.run(
                _build_cmd("-/filter_complex", script_path),
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0 and "Unrecognized option" in proc.stderr:
                proc = subprocess.run(
                    _build_cmd("-filter_complex_script", script_path),
                    capture_output=True,
                    text=True,
                )
        else:
            proc = subprocess.run(
                _build_cmd("-filter_complex", filter_graph),
                capture_output=True,
                text=True,
            )
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg 匯出失敗: {proc.stderr[-800:]}")
    finally:
        if os.path.exists(script_path):
            os.remove(script_path)

    # Generate UTF-8 SRT
    srt_content = generate_remapped_srt(segments, keep_ranges)
    Path(output_srt_path).write_text(srt_content, encoding="utf-8")

    # Package MP4 + SRT into ZIP bundle
    with zipfile.ZipFile(output_zip_path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.write(output_mp4_path, arcname=Path(output_mp4_path).name)
        zf.write(output_srt_path, arcname=Path(output_srt_path).name)

    exported_duration = round(sum(r.end - r.start for r in keep_ranges), 3)
    orig_dur = round(total_duration or keep_ranges[-1].end, 3)

    return {
        "keep_ranges": keep_ranges,
        "srt_content": srt_content,
        "original_duration": orig_dur,
        "exported_duration": exported_duration,
        "saved_seconds": round(max(0.0, orig_dur - exported_duration), 3),
        "cut_count": max(0, len(keep_ranges) - 1),
    }
