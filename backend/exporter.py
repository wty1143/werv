import os
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import List, Optional

from .asr_engine import FFMPEG_BIN, probe_video_metadata
from .models import KeepRange, Segment, Token, SubtitleStyle

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
    pre_pad = max(padding, 0.08)
    post_pad = max(padding, 0.05)

    flat_tokens: List[Token] = [tok for seg in segments for tok in seg.tokens]
    if not flat_tokens:
        return []

    # Group contiguous sequences of deleted == False tokens
    # Cuts ONLY happen where a token is deleted; un-deleted sequences are kept continuously.
    blocks: List[List[Token]] = []
    current_block: List[Token] = []

    for tok in flat_tokens:
        if not tok.deleted:
            if (
                tok.type == "silence"
                and tok.keep_duration is not None
                and tok.keep_duration > 0
                and tok.keep_duration < (tok.end - tok.start)
            ):
                sub_end = round(tok.start + tok.keep_duration, 3)
                current_block.append(
                    Token(
                        id=tok.id,
                        type=tok.type,
                        text=tok.text,
                        start=tok.start,
                        end=sub_end,
                        deleted=False,
                        keep_duration=tok.keep_duration,
                    )
                )
                blocks.append(current_block)
                current_block = []
            elif tok.type == "silence" and tok.keep_duration == 0:
                if current_block:
                    blocks.append(current_block)
                    current_block = []
            else:
                current_block.append(tok)
        else:
            if current_block:
                blocks.append(current_block)
                current_block = []
    if current_block:
        blocks.append(current_block)

    if not blocks:
        return []

    raw_intervals: List[List[float]] = []
    for b in blocks:
        s = max(0.0, b[0].start - pre_pad)
        last_tok = b[-1]
        if last_tok.type == "silence" and last_tok.keep_duration is not None:
            e = last_tok.end
        else:
            e = last_tok.end + post_pad
        if total_duration is not None and total_duration > 0:
            e = min(total_duration, e)
        if e > s:
            raw_intervals.append([s, e])

    if not raw_intervals:
        return []

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

        if seg.caption is not None:
            line_text = seg.caption.strip()
        else:
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


def resolve_macos_font_path(font_family: str) -> str:
    """Find a guaranteed system font path on macOS compatible with FreeType/Pillow."""
    family_map = {
        "pingfang": [
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        ],
        "heiti": [
            "/System/Library/Fonts/STHeiti Medium.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
        ],
        "songti": [
            "/System/Library/Fonts/Supplemental/Songti.ttc",
            "/System/Library/Fonts/Songti.ttc",
        ],
        "hiragino": [
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        ],
    }
    for p in family_map.get(font_family, family_map["pingfang"]):
        if os.path.exists(p):
            return p
    for fallback in [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]:
        if os.path.exists(fallback):
            return fallback
    return "Arial.ttf"


def wrap_text_cjk(text: str, font, max_width: int) -> List[str]:
    """Break text into lines if it exceeds max_width."""
    if not text:
        return []
    bbox = font.getbbox(text)
    if (bbox[2] - bbox[0]) <= max_width:
        return [text]

    lines: List[str] = []
    current_line = ""
    for char in text:
        test_line = current_line + char
        bbox = font.getbbox(test_line)
        if (bbox[2] - bbox[0]) > max_width and current_line:
            lines.append(current_line)
            current_line = char
        else:
            current_line = test_line
    if current_line:
        lines.append(current_line)
    return lines


def render_subtitle_overlay_track(
    temp_dir: str,
    segments: List[Segment],
    keep_ranges: List[KeepRange],
    subtitle_style: SubtitleStyle,
    video_width: int,
    video_height: int,
    total_duration: float,
) -> Optional[str]:
    """
    Render transparent RGBA subtitle PNG overlays and generate an ffconcat list
    for single-pass FFmpeg hardware overlay compositing.
    """
    from PIL import Image, ImageDraw, ImageFont

    if not subtitle_style.enabled or not segments or not keep_ranges:
        return None

    # 1. Collect subtitle events with remapped timeline timestamps
    raw_events: List[dict] = []
    for seg in segments:
        kept_words = [t for t in seg.tokens if not t.deleted and t.type == "word" and t.text.strip()]
        if not kept_words:
            continue

        if seg.caption is not None:
            line_text = seg.caption.strip()
        else:
            line_text = join_tokens_text(kept_words)

        if not line_text:
            continue

        s = remap_timestamp(kept_words[0].start, keep_ranges)
        e = remap_timestamp(kept_words[-1].end, keep_ranges)
        if e <= s + 0.05:
            e = round(s + 0.1, 3)

        s = max(0.0, min(total_duration, s))
        e = max(s + 0.05, min(total_duration, e))
        raw_events.append({"start": s, "end": e, "text": line_text})

    if not raw_events:
        return None

    raw_events.sort(key=lambda x: x["start"])

    # Resolve overlapping subtitle events
    events: List[dict] = []
    for ev in raw_events:
        if events and ev["start"] < events[-1]["end"]:
            events[-1]["end"] = max(events[-1]["start"] + 0.05, ev["start"])
        if ev["end"] > ev["start"] + 0.02:
            events.append(ev)

    if not events:
        return None

    # 2. Setup typography scaled to canvas height (reference 1080p)
    scale = video_height / 1080.0
    scaled_font_size = max(18, int(round(subtitle_style.font_size * scale)))
    font_path = resolve_macos_font_path(subtitle_style.font_family)
    try:
        font = ImageFont.truetype(font_path, scaled_font_size)
    except Exception:
        font = ImageFont.load_default()

    # 3. Create transparent blank PNG
    blank_png = os.path.join(temp_dir, "blank.png")
    Image.new("RGBA", (video_width, video_height), (0, 0, 0, 0)).save(blank_png, "PNG")

    # 4. Render subtitle PNGs
    max_text_w = int(video_width * 0.88)
    pad_x = max(14, int(round(26 * scale)))
    pad_y = max(8, int(round(12 * scale)))
    line_spacing = max(4, int(round(8 * scale)))
    corner_radius = max(8, int(round(14 * scale)))
    outline_w = max(2, int(round(subtitle_style.outline_width * scale)))
    bottom_offset_px = int(video_height * (subtitle_style.bottom_offset_pct / 100.0))

    def _hex_to_rgb(hex_str: str):
        hex_clean = hex_str.lstrip("#")
        if len(hex_clean) == 6:
            return tuple(int(hex_clean[i : i + 2], 16) for i in (0, 2, 4))
        return (255, 255, 255)

    text_rgb = _hex_to_rgb(subtitle_style.text_color)
    box_alpha = int(max(0.1, min(1.0, subtitle_style.box_opacity)) * 255)

    rendered_pngs: List[str] = []
    for idx, ev in enumerate(events):
        img = Image.new("RGBA", (video_width, video_height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        lines = wrap_text_cjk(ev["text"], font, max_text_w)
        line_metrics = []
        for line in lines:
            bbox = font.getbbox(line)
            lw = bbox[2] - bbox[0]
            lh = bbox[3] - bbox[1]
            line_metrics.append((line, lw, lh, bbox))

        max_lw = max((m[1] for m in line_metrics), default=0)
        total_text_h = sum(m[2] for m in line_metrics) + (len(lines) - 1) * line_spacing

        box_w = max_lw + pad_x * 2
        box_h = total_text_h + pad_y * 2
        box_x = (video_width - box_w) // 2
        box_y = max(10, min(video_height - box_h - 10, video_height - bottom_offset_px - box_h))

        if subtitle_style.style_mode == "box":
            draw.rounded_rectangle(
                [box_x, box_y, box_x + box_w, box_y + box_h],
                radius=corner_radius,
                fill=(12, 16, 26, box_alpha),
                outline=(255, 255, 255, 35),
                width=1,
            )

        cur_y = box_y + pad_y
        for line, lw, lh, bbox in line_metrics:
            text_x = (video_width - lw) // 2 - bbox[0]
            text_y = cur_y - bbox[1]

            if subtitle_style.style_mode == "outline":
                draw.text(
                    (text_x, text_y),
                    line,
                    font=font,
                    fill=(*text_rgb, 255),
                    stroke_width=outline_w,
                    stroke_fill=(0, 0, 0, 240),
                )
            elif subtitle_style.style_mode == "shadow":
                shadow_offset = max(2, int(round(3 * scale)))
                draw.text(
                    (text_x + shadow_offset, text_y + shadow_offset),
                    line,
                    font=font,
                    fill=(0, 0, 0, 200),
                )
                draw.text(
                    (text_x, text_y),
                    line,
                    font=font,
                    fill=(*text_rgb, 255),
                )
            else:  # box mode
                draw.text(
                    (text_x, text_y),
                    line,
                    font=font,
                    fill=(*text_rgb, 255),
                )
            cur_y += lh + line_spacing

        png_path = os.path.join(temp_dir, f"sub_{idx:04d}.png")
        img.save(png_path, "PNG", compress_level=1)
        rendered_pngs.append(png_path)

    # 5. Build ffconcat timeline
    concat_file = os.path.join(temp_dir, "subs.ffconcat")
    with open(concat_file, "w", encoding="utf-8") as f:
        f.write("ffconcat version 1.0\n")
        cur_time = 0.0
        for ev, png_path in zip(events, rendered_pngs):
            s = ev["start"]
            e = ev["end"]
            if s > cur_time + 0.01:
                gap = s - cur_time
                f.write(f"file 'blank.png'\nduration {gap:.4f}\n")
            dur = max(0.04, e - s)
            png_name = os.path.basename(png_path)
            f.write(f"file '{png_name}'\nduration {dur:.4f}\n")
            cur_time = e

        if cur_time < total_duration:
            f.write(f"file 'blank.png'\nduration {total_duration - cur_time:.4f}\n")
        f.write("file 'blank.png'\n")

    return concat_file


def build_filter_complex(
    keep_ranges: List[KeepRange],
    fade_sec: float = 0.015,
    has_subtitle_overlay: bool = False,
) -> str:
    """
    Build FFmpeg filter_complex graph using `trim` and `atrim` for each range,
    with 15ms audio fade-in/fade-out at cut points to prevent Audio Pop,
    optionally compositing burned-in subtitle stream via overlay filter.
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

    if has_subtitle_overlay:
        concat_str = "".join(concat_inputs) + f"concat=n={n}:v=1:a=1[cutv][outa];"
        lines.append(concat_str)
        lines.append("[cutv][1:v]overlay=0:0:shortest=1[outv]")
    else:
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
    subtitle_style: Optional[SubtitleStyle] = None,
) -> dict:
    """
    Module D Hardware-Accelerated Export with optional Hardcoded Subtitle Burn-In:
    - Computes keep_ranges
    - Renders transparent subtitle overlays with macOS native typography if enabled
    - Encodes with Apple VideoToolbox: -c:v h264_videotoolbox -b:v 15M -pix_fmt yuv420p -c:a aac -b:a 192k
    - Writes UTF-8 .srt as backup
    """
    keep_ranges = compute_keep_ranges(
        segments=segments,
        padding=padding,
        merge_gap=merge_gap,
        total_duration=total_duration,
    )
    if not keep_ranges:
        raise ValueError("無法匯出：所有片段皆已被刪除，請至少保留一個字元或片段。")

    meta = probe_video_metadata(input_video_path)
    video_width = meta.get("width", 1920)
    video_height = meta.get("height", 1080)
    exported_duration = round(sum(r.end - r.start for r in keep_ranges), 3)
    orig_dur = round(total_duration or meta.get("duration", 0.0) or keep_ranges[-1].end, 3)

    fade_sec = max(0.005, fade_ms / 1000.0)

    # Subtitle overlay generation
    sub_concat_file = None
    sub_tmpdir_obj = None

    if subtitle_style and subtitle_style.enabled:
        sub_tmpdir_obj = tempfile.TemporaryDirectory()
        sub_concat_file = render_subtitle_overlay_track(
            temp_dir=sub_tmpdir_obj.name,
            segments=segments,
            keep_ranges=keep_ranges,
            subtitle_style=subtitle_style,
            video_width=video_width,
            video_height=video_height,
            total_duration=exported_duration,
        )

    has_subtitles = sub_concat_file is not None

    filter_graph = build_filter_complex(
        keep_ranges=keep_ranges,
        fade_sec=fade_sec,
        has_subtitle_overlay=has_subtitles,
    )

    # When kept segments > 50, write filter_complex to a temporary script file to avoid OS arg length limits.
    with tempfile.NamedTemporaryFile("w", suffix=".filter", delete=False, encoding="utf-8") as f_script:
        f_script.write(filter_graph)
        script_path = f_script.name

    def _build_cmd(filter_flag: str, filter_val: str) -> List[str]:
        cmd = [
            FFMPEG_BIN,
            "-y",
            "-i",
            input_video_path,
        ]
        if has_subtitles:
            cmd.extend(["-f", "concat", "-safe", "0", "-i", sub_concat_file])
        cmd.extend([
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
        ])
        return cmd

    try:
        if len(keep_ranges) > 50 or has_subtitles:
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
        if sub_tmpdir_obj is not None:
            sub_tmpdir_obj.cleanup()

    # Generate UTF-8 SRT backup
    srt_content = generate_remapped_srt(segments, keep_ranges)
    Path(output_srt_path).write_text(srt_content, encoding="utf-8")

    # Optional ZIP bundle creation
    if output_zip_path:
        with zipfile.ZipFile(output_zip_path, "w", compression=zipfile.ZIP_STORED) as zf:
            zf.write(output_mp4_path, arcname=Path(output_mp4_path).name)
            zf.write(output_srt_path, arcname=Path(output_srt_path).name)

    return {
        "keep_ranges": keep_ranges,
        "srt_content": srt_content,
        "original_duration": orig_dur,
        "exported_duration": exported_duration,
        "saved_seconds": round(max(0.0, orig_dur - exported_duration), 3),
        "cut_count": max(0, len(keep_ranges) - 1),
    }
