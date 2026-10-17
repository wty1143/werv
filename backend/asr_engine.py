import difflib
import json
import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from opencc import OpenCC

from .models import Segment, Token

# Default Taiwanese Traditional Chinese initial prompt for Whisper
DEFAULT_TW_INITIAL_PROMPT = (
    "以下是台灣繁體中文的語音逐字稿，請使用台灣繁體中文與台灣慣用詞彙："
    "影片、軟體、硬體、網路、伺服器、滑鼠、品質、預設、專案、逐字稿、剪輯、贅字、空白氣口、匯出、時間軸、字幕檔、剪映、後製。"
)

_cc_s2tw = OpenCC("s2tw")
_cc_s2twp = OpenCC("s2twp")
_vad_model = None

FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else "ffmpeg"
FFPROBE_BIN = "/opt/homebrew/bin/ffprobe" if os.path.exists("/opt/homebrew/bin/ffprobe") else "ffprobe"


def get_vad_model():
    global _vad_model
    if _vad_model is None:
        from silero_vad import load_silero_vad
        _vad_model = load_silero_vad()
    return _vad_model


def probe_video_metadata(video_path: str) -> Dict[str, Any]:
    """Use ffprobe to extract duration, width, height, and fps."""
    cmd = [
        FFPROBE_BIN,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    data = json.loads(res.stdout)
    duration = float(data.get("format", {}).get("duration", 0.0))
    width = 1920
    height = 1080
    fps = 30.0

    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            width = int(stream.get("width", width))
            height = int(stream.get("height", height))
            r_frame_rate = stream.get("r_frame_rate", "30/1")
            if "/" in r_frame_rate:
                num, den = r_frame_rate.split("/", 1)
                if float(den) > 0:
                    fps = round(float(num) / float(den), 3)
            else:
                try:
                    fps = float(r_frame_rate)
                except ValueError:
                    fps = 30.0
            if duration <= 0 and stream.get("duration"):
                duration = float(stream["duration"])
            break

    return {
        "duration": round(duration, 3),
        "width": width,
        "height": height,
        "fps": fps,
    }


def extract_16k_wav(video_path: str, wav_path: str) -> None:
    """Extract 16kHz mono PCM WAV from video for silero-vad & mlx-whisper."""
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        video_path,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        wav_path,
    ]
    subprocess.run(cmd, capture_output=True, check=True)


def run_silero_vad(wav_path: str) -> List[Dict[str, float]]:
    """Run silero-vad on 16kHz wav file and return speech intervals in seconds."""
    import soundfile as sf
    import torch
    from silero_vad import get_speech_timestamps

    audio_np, sr = sf.read(wav_path, dtype="float32")
    if audio_np.ndim > 1:
        audio_np = audio_np.mean(axis=1)
    wav_tensor = torch.from_numpy(audio_np)
    model = get_vad_model()
    speech_ts = get_speech_timestamps(
        wav_tensor,
        model,
        sampling_rate=sr,
        return_seconds=True,
        threshold=0.30,
        min_speech_duration_ms=60,
        min_silence_duration_ms=100,
        speech_pad_ms=50,
    )
    return [{"start": float(item["start"]), "end": float(item["end"])} for item in speech_ts]


_TOKEN_SPLIT_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]|[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?")
_PUNCT_BREAK_RE = re.compile(r"[，。？！；：,.\?!;:]+\s*$")


def _split_raw_word_to_units(text: str, start: float, end: float) -> List[Dict[str, Any]]:
    """
    Split a Whisper word into character-level CJK tokens and word-level English/number tokens,
    linearly interpolating timestamps across sub-units.
    """
    has_punct_break = bool(_PUNCT_BREAK_RE.search(text))
    matches = _TOKEN_SPLIT_RE.findall(text)
    if not matches:
        cleaned = re.sub(r"[，。？！；：,.\?!;:\s]+", "", text)
        if not cleaned:
            return []
        return [{"text": cleaned, "start": start, "end": end, "break_after": has_punct_break}]

    total_weight = sum(len(m) for m in matches) or 1
    dur = max(0.02, end - start)
    units: List[Dict[str, Any]] = []
    cursor = start
    for i, m in enumerate(matches):
        weight = len(m)
        u_dur = dur * (weight / total_weight)
        u_start = cursor
        u_end = end if i == len(matches) - 1 else (cursor + u_dur)
        units.append(
            {
                "text": m,
                "start": round(u_start, 3),
                "end": round(u_end, 3),
                "break_after": has_punct_break if i == len(matches) - 1 else False,
            }
        )
        cursor = u_end
    return units


def _convert_units_s2twp(units: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Convert atomic units to Taiwanese Traditional Chinese via OpenCC (s2twp)
    while preserving exact per-character / per-word timestamps.
    """
    if not units:
        return []

    # First convert each unit with 1-to-1 s2tw so lengths match unit-by-unit
    s2tw_texts = [_cc_s2tw.convert(u["text"]) for u in units]

    # Build character-to-unit mapping for the concatenated string
    concat_s2tw = "".join(s2tw_texts)
    concat_s2twp = _cc_s2twp.convert("".join(u["text"] for u in units))
    for wrong, right in (
        ("竹字稿", "逐字稿"),
        ("足字稿", "逐字稿"),
        ("墜字", "贅字"),
        ("會出", "匯出"),
        ("座後置", "做後製"),
        ("座後製", "做後製"),
        ("做後置", "做後製"),
    ):
        concat_s2twp = concat_s2twp.replace(wrong, right)

    if concat_s2tw == concat_s2twp:
        return [
            {
                "text": s2tw_texts[i],
                "start": units[i]["start"],
                "end": units[i]["end"],
                "break_after": bool(units[i].get("break_after", False)),
            }
            for i in range(len(units))
        ]

    # If all units are single-char or we align via SequenceMatcher:
    # Map each char index in concat_s2tw to its unit index
    char_to_unit: List[int] = []
    for idx, t in enumerate(s2tw_texts):
        char_to_unit.extend([idx] * max(1, len(t)))

    matcher = difflib.SequenceMatcher(None, concat_s2tw, concat_s2twp, autojunk=False)
    result_units: List[Dict[str, Any]] = []
    consumed_units = set()

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            # Emit original units covered in [i1, i2)
            for c_idx in range(i1, i2):
                u_idx = char_to_unit[c_idx]
                if u_idx not in consumed_units:
                    consumed_units.add(u_idx)
                    result_units.append(
                        {
                            "text": s2tw_texts[u_idx],
                            "start": units[u_idx]["start"],
                            "end": units[u_idx]["end"],
                            "break_after": bool(units[u_idx].get("break_after", False)),
                        }
                    )
        elif tag in ("replace", "insert"):
            rep_text = concat_s2twp[j1:j2]
            has_break = False
            if i1 < i2 and i1 < len(char_to_unit):
                u_first = char_to_unit[i1]
                u_last = char_to_unit[min(i2 - 1, len(char_to_unit) - 1)]
                span_start = units[u_first]["start"]
                span_end = units[u_last]["end"]
                has_break = any(bool(units[u_idx].get("break_after", False)) for u_idx in range(u_first, u_last + 1))
                for u_idx in range(u_first, u_last + 1):
                    consumed_units.add(u_idx)
            elif result_units:
                span_start = result_units[-1]["end"]
                span_end = span_start + 0.08
            else:
                span_start = units[0]["start"]
                span_end = units[0]["end"]

            sub = _split_raw_word_to_units(rep_text, span_start, span_end)
            if sub and has_break:
                sub[-1]["break_after"] = True
            result_units.extend(sub)
        elif tag == "delete":
            for c_idx in range(i1, i2):
                if c_idx < len(char_to_unit):
                    consumed_units.add(char_to_unit[c_idx])

    return result_units


def calibrate_with_vad(
    segments_units: List[List[Dict[str, Any]]],
    vad_intervals: List[Dict[str, float]],
) -> List[List[Dict[str, Any]]]:
    """
    Calibrate segment start/end and stretched word tails against silero-vad speech boundaries.
    1. Forward protection: If Whisper's first token start lags behind real speech onset (vad_s < first.start),
       pull first.start back to vad_s so the first consonant/syllable is NOT swallowed by silence.
    2. Boundary clamping: If first.start starts too early into preceding long silence, snap to vad_s.
    3. Tail protection: If last.end stops before vad_e, extend last.end to vad_e.
    4. Tail clamping: If last.end drags into trailing silence, clamp to vad_e.
    """
    if not vad_intervals:
        return segments_units

    prev_seg_end = 0.0
    for seg_idx, seg in enumerate(segments_units):
        if not seg:
            continue

        first = seg[0]
        # Find any VAD speech interval covering or immediately preceding the first token
        covering_first = [
            v for v in vad_intervals if v["end"] >= first["start"] - 0.35 and v["start"] <= first["end"] + 0.15
        ]
        if covering_first:
            target_vad = covering_first[0]
            vad_s = target_vad["start"]
            # Case A: Whisper lagged behind acoustic onset (vad_s < first["start"])
            if vad_s < first["start"] and vad_s >= prev_seg_end:
                first["start"] = round(vad_s, 3)
            # Case B: Whisper started too early into leading silence (vad_s > first["start"] + 0.04)
            elif vad_s > first["start"] + 0.04 and vad_s < first["end"] - 0.04:
                first["start"] = round(vad_s, 3)

        # 2. Calibrate last token end
        last = seg[-1]
        next_seg_start = (
            segments_units[seg_idx + 1][0]["start"]
            if seg_idx < len(segments_units) - 1 and segments_units[seg_idx + 1]
            else 999999.0
        )
        covering_last = [
            v for v in vad_intervals if v["end"] >= last["start"] and v["start"] <= last["end"] + 0.35
        ]
        if covering_last:
            target_vad = covering_last[-1]
            vad_e = target_vad["end"]
            # Case A: Voice continued after Whisper's timestamp (vad_e > last["end"])
            if vad_e > last["end"] and vad_e <= next_seg_start:
                last["end"] = round(min(vad_e, last["end"] + 0.40), 3)
            # Case B: Whisper dragged into trailing silence (vad_e < last["end"] - 0.04)
            elif vad_e < last["end"] - 0.04 and vad_e > last["start"] + 0.05:
                last["end"] = round(vad_e, 3)

        # 3. Calibrate any mid-segment token that stretched across an internal VAD pause
        for idx, tok in enumerate(seg[:-1]):
            dur = tok["end"] - tok["start"]
            if dur > 0.35:
                covering = [
                    v
                    for v in vad_intervals
                    if v["start"] <= tok["start"] + 0.12 and v["end"] >= tok["start"] + 0.04
                ]
                if covering:
                    vad_e = covering[0]["end"]
                    next_start = seg[idx + 1]["start"]
                    if tok["start"] + 0.06 <= vad_e < tok["end"] - 0.05 and vad_e <= next_start:
                        tok["end"] = round(vad_e, 3)

        prev_seg_end = last["end"]

    return segments_units


def format_silence_label(duration: float) -> str:
    return f"[··· {duration:.1f}s]"


def insert_silence_tokens(
    raw_segments: List[List[Dict[str, Any]]],
    silence_threshold: float = 0.4,
    total_duration: Optional[float] = None,
    existing_deleted_map: Optional[Dict[Tuple[int, int], bool]] = None,
    vad_intervals: Optional[List[Dict[str, float]]] = None,
) -> List[Segment]:
    """
    Given word-only segments, detect silence gaps between words.
    Crucially uses VAD speech intervals (if available) to guarantee silence tokens NEVER
    overlap with human voice, preventing the first words of the next sentence from being cut.
    """
    existing_deleted_map = existing_deleted_map or {}

    def is_silence_deleted(s: float, e: float) -> bool:
        key = (int(round(s * 20)), int(round(e * 20)))
        return existing_deleted_map.get(key, False)

    # Filter out empty segments
    non_empty = [seg for seg in raw_segments if seg]
    if not non_empty:
        return []

    # If VAD intervals are provided, check gaps between words and pull next words earlier
    # if VAD speech already began inside the candidate gap
    if vad_intervals:
        flat_words = [w for seg in non_empty for w in seg]
        for idx in range(len(flat_words) - 1):
            curr_w = flat_words[idx]
            next_w = flat_words[idx + 1]
            c_end = float(curr_w["end"])
            n_start = float(next_w["start"])
            if n_start > c_end:
                # Find any speech starting inside this gap
                speech_in_gap = [
                    v for v in vad_intervals if v["end"] > c_end and v["start"] < n_start
                ]
                if speech_in_gap:
                    last_speech = speech_in_gap[-1]
                    if last_speech["start"] < n_start and last_speech["start"] >= c_end:
                        next_w["start"] = round(last_speech["start"], 3)
                    first_speech = speech_in_gap[0]
                    if first_speech["end"] > c_end and first_speech["end"] <= next_w["start"]:
                        curr_w["end"] = round(first_speech["end"], 3)

    output_segments: List[Segment] = []
    prev_word_end: Optional[float] = None

    for seg_idx, word_list in enumerate(non_empty):
        seg_tokens: List[Token] = []

        # Leading silence before the very first word of the video
        if seg_idx == 0:
            first_w_start = round(float(word_list[0]["start"]), 3)
            # Find earliest VAD speech before first word if any
            if vad_intervals and first_w_start > 0:
                early_speech = [v for v in vad_intervals if v["start"] < first_w_start]
                if early_speech and early_speech[0]["start"] < first_w_start:
                    first_w_start = round(early_speech[0]["start"], 3)
                    word_list[0]["start"] = first_w_start

            if first_w_start >= silence_threshold:
                s_start = 0.0
                s_end = first_w_start
                gap = round(s_end - s_start, 3)
                seg_tokens.append(
                    Token(
                        id=f"tok_{uuid.uuid4().hex[:8]}",
                        type="silence",
                        text=format_silence_label(gap),
                        start=s_start,
                        end=s_end,
                        deleted=is_silence_deleted(s_start, s_end),
                    )
                )

        for w_idx, w in enumerate(word_list):
            w_start = round(float(w["start"]), 3)
            w_end = round(max(w_start + 0.02, float(w["end"])), 3)

            # Check intra-segment gap
            if w_idx > 0 and prev_word_end is not None:
                gap = round(w_start - prev_word_end, 3)
                if gap >= silence_threshold:
                    seg_tokens.append(
                        Token(
                            id=f"tok_{uuid.uuid4().hex[:8]}",
                            type="silence",
                            text=format_silence_label(gap),
                            start=prev_word_end,
                            end=w_start,
                            deleted=is_silence_deleted(prev_word_end, w_start),
                        )
                    )

            seg_tokens.append(
                Token(
                    id=w.get("id") or f"tok_{uuid.uuid4().hex[:8]}",
                    type="word",
                    text=str(w["text"]),
                    start=w_start,
                    end=w_end,
                    deleted=bool(w.get("deleted", False)),
                )
            )
            prev_word_end = w_end

        # Inter-segment silence (placed at tail of current segment)
        if seg_idx < len(non_empty) - 1:
            next_seg_first_start = round(float(non_empty[seg_idx + 1][0]["start"]), 3)
            if prev_word_end is not None:
                gap = round(next_seg_first_start - prev_word_end, 3)
                if gap >= silence_threshold:
                    seg_tokens.append(
                        Token(
                            id=f"tok_{uuid.uuid4().hex[:8]}",
                            type="silence",
                            text=format_silence_label(gap),
                            start=prev_word_end,
                            end=next_seg_first_start,
                            deleted=is_silence_deleted(prev_word_end, next_seg_first_start),
                        )
                    )
        elif total_duration is not None and prev_word_end is not None:
            # Trailing silence at the end of video
            gap = round(total_duration - prev_word_end, 3)
            if gap >= silence_threshold:
                seg_tokens.append(
                    Token(
                        id=f"tok_{uuid.uuid4().hex[:8]}",
                        type="silence",
                        text=format_silence_label(gap),
                        start=prev_word_end,
                        end=round(total_duration, 3),
                        deleted=is_silence_deleted(prev_word_end, round(total_duration, 3)),
                    )
                )

        output_segments.append(
            Segment(
                id=f"seg_{uuid.uuid4().hex[:8]}",
                tokens=seg_tokens,
            )
        )

    return output_segments


def rebuild_silence_for_segments(
    segments: List[Segment],
    silence_threshold: float = 0.4,
    total_duration: Optional[float] = None,
) -> List[Segment]:
    """Re-evaluate silence tokens when user adjusts the silence threshold slider in UI."""
    existing_deleted_map: Dict[Tuple[int, int], bool] = {}
    word_segments: List[List[Dict[str, Any]]] = []

    for seg in segments:
        words: List[Dict[str, Any]] = []
        for tok in seg.tokens:
            if tok.type == "silence":
                key = (int(round(tok.start * 20)), int(round(tok.end * 20)))
                existing_deleted_map[key] = tok.deleted
            else:
                words.append(
                    {
                        "id": tok.id,
                        "text": tok.text,
                        "start": tok.start,
                        "end": tok.end,
                        "deleted": tok.deleted,
                    }
                )
        if words:
            word_segments.append(words)

    return insert_silence_tokens(
        word_segments,
        silence_threshold=silence_threshold,
        total_duration=total_duration,
        existing_deleted_map=existing_deleted_map,
    )


def transcribe_video_file(
    video_path: str,
    model_name: str = "mlx-community/whisper-large-v3-turbo",
    custom_prompt: str = "",
    silence_threshold: float = 0.4,
    total_duration: Optional[float] = None,
) -> List[Segment]:
    """
    Full Module A pipeline:
    1. Extract 16kHz WAV
    2. Run silero-vad to obtain speech start/end intervals
    3. Run mlx-whisper with language='zh', word_timestamps=True, condition_on_previous_text=False, initial_prompt
    4. Convert tokens via OpenCC('s2twp') to Taiwanese Traditional Chinese
    5. Calibrate word start/end boundaries with silero-vad
    6. Detect and insert silence tokens (>= silence_threshold)
    """
    import mlx_whisper

    with tempfile.TemporaryDirectory() as tmpdir:
        wav_path = os.path.join(tmpdir, "audio_16k.wav")
        extract_16k_wav(video_path, wav_path)

        # Step 1: Silero VAD
        vad_intervals = run_silero_vad(wav_path)

        # Step 2: Compose initial_prompt
        prompt = DEFAULT_TW_INITIAL_PROMPT
        if custom_prompt and custom_prompt.strip():
            cleaned_custom = _cc_s2twp.convert(custom_prompt.strip())
            prompt = f"{DEFAULT_TW_INITIAL_PROMPT} 專有名詞與關鍵字：{cleaned_custom}。"

        # Step 3: MLX Whisper transcription
        result = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo=model_name,
            language="zh",
            word_timestamps=True,
            condition_on_previous_text=False,
            initial_prompt=prompt,
        )

    raw_segments_units: List[List[Dict[str, Any]]] = []
    for seg in result.get("segments", []):
        words = seg.get("words", [])
        seg_units: List[Dict[str, Any]] = []
        if words:
            for w in words:
                w_text = str(w.get("word", "")).strip()
                w_start = float(w.get("start", seg.get("start", 0.0)))
                w_end = float(w.get("end", seg.get("end", w_start + 0.1)))
                seg_units.extend(_split_raw_word_to_units(w_text, w_start, w_end))
        else:
            # Fallback if a segment lacked words array
            s_text = str(seg.get("text", "")).strip()
            s_start = float(seg.get("start", 0.0))
            s_end = float(seg.get("end", s_start + 0.5))
            seg_units.extend(_split_raw_word_to_units(s_text, s_start, s_end))

        # Convert to Taiwanese Traditional Chinese (OpenCC s2twp)
        seg_units = _convert_units_s2twp(seg_units)
        if seg_units:
            raw_segments_units.append(seg_units)

    # Step 4: Calibrate boundaries using silero-vad
    calibrated_segments = calibrate_with_vad(raw_segments_units, vad_intervals)

    # Step 5: Ensure strictly non-overlapping monotonic word timestamps
    prev_end = 0.0
    for seg in calibrated_segments:
        for u in seg:
            if u["start"] < prev_end:
                u["start"] = round(prev_end, 3)
            if u["end"] <= u["start"]:
                u["end"] = round(u["start"] + 0.04, 3)
            prev_end = u["end"]

    # Step 5.5: Split overly long segments into natural Vrew-style subtitle rows (Segment = 1 SRT line)
    clause_rows: List[List[Dict[str, Any]]] = []
    for seg in calibrated_segments:
        current_row: List[Dict[str, Any]] = []
        for idx, u in enumerate(seg):
            current_row.append(u)
            is_last = idx == len(seg) - 1
            if is_last:
                break
            next_u = seg[idx + 1]
            gap = round(float(next_u["start"]) - float(u["end"]), 3)
            has_punct = bool(u.get("break_after", False))
            # Check how many characters remain before the next natural pause or end of segment
            rem_before_pause = 0
            for k in range(idx + 1, len(seg)):
                rem_before_pause += 1
                if bool(seg[k].get("break_after", False)):
                    break
                if k < len(seg) - 1 and (float(seg[k + 1]["start"]) - float(seg[k]["end"])) >= 0.08:
                    break

            if (
                has_punct
                or gap >= silence_threshold
                or (gap >= 0.08 and len(current_row) >= 3)
                or (len(current_row) >= 22 and rem_before_pause >= 4)
            ):
                clause_rows.append(current_row)
                current_row = []
        if current_row:
            clause_rows.append(current_row)

    # Step 6: Insert silence tokens strictly bounded by VAD non-speech intervals
    return insert_silence_tokens(
        clause_rows,
        silence_threshold=silence_threshold,
        total_duration=total_duration,
        vad_intervals=vad_intervals,
    )

