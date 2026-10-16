import { KeepRange, Segment, Token } from './types'

const ASCII_WORD_RE = /^[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?$/

/**
 * Module C: Virtual Timeline Keep Ranges Calculation
 * 1. Extract all tokens where deleted === false
 * 2. Pad each interval by `padding` (default 0.05s) on both ends
 * 3. Merge overlapping intervals or adjacent intervals within `mergeGap` (default 0.08s)
 */
export function computeKeepRanges(
  segments: Segment[],
  padding = 0.05,
  mergeGap = 0.08,
  totalDuration?: number
): KeepRange[] {
  const raw: [number, number][] = []

  for (const seg of segments) {
    for (const tok of seg.tokens) {
      if (!tok.deleted) {
        const s = Math.max(0, tok.start - padding)
        let e = tok.end + padding
        if (totalDuration && totalDuration > 0) {
          e = Math.min(totalDuration, e)
        }
        if (e > s) {
          raw.push([s, e])
        }
      }
    }
  }

  if (raw.length === 0) return []

  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = [raw[0]]

  for (let i = 1; i < raw.length; i++) {
    const [currS, currE] = raw[i]
    const prev = merged[merged.length - 1]
    if (currS - prev[1] <= mergeGap + 1e-6) {
      prev[1] = Math.max(prev[1], currE)
    } else {
      merged.push([currS, currE])
    }
  }

  return merged
    .filter(([s, e]) => e - s >= 0.02)
    .map(([s, e]) => ({
      start: Number(s.toFixed(3)),
      end: Number(e.toFixed(3)),
    }))
}

/**
 * Used in the requestAnimationFrame loop to determine if playhead is inside a kept range
 * or needs to immediately seek to the next kept range's start.
 */
export function resolveVirtualPlayhead(
  currentTime: number,
  keepRanges: KeepRange[]
): { action: 'keep' } | { action: 'seek'; targetTime: number } | { action: 'end'; targetTime: number } {
  if (keepRanges.length === 0) {
    return { action: 'end', targetTime: 0 }
  }

  const epsilon = 0.012
  for (let i = 0; i < keepRanges.length; i++) {
    const r = keepRanges[i]
    if (currentTime < r.start - epsilon) {
      return { action: 'seek', targetTime: r.start }
    }
    if (currentTime >= r.start - epsilon && currentTime <= r.end + epsilon) {
      return { action: 'keep' }
    }
  }

  // Playhead is past the last kept range
  return { action: 'end', targetTime: keepRanges[0].start }
}

export function remapTimestamp(origTime: number, keepRanges: KeepRange[]): number {
  let accum = 0
  for (const r of keepRanges) {
    if (origTime <= r.start) break
    accum += Math.max(0, Math.min(origTime, r.end) - r.start)
    if (origTime <= r.end) break
  }
  return Number(accum.toFixed(3))
}

export function formatSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const totalMs = Math.round(clamped * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  let rem = totalMs % 3_600_000
  const minutes = Math.floor(rem / 60_000)
  rem = rem % 60_000
  const secs = Math.floor(rem / 1000)
  const ms = rem % 1000
  return (
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(secs).padStart(2, '0') +
    ',' +
    String(ms).padStart(3, '0')
  )
}

export function formatDisplayTime(seconds: number, showTenths = true): string {
  const clamped = Math.max(0, seconds || 0)
  const mins = Math.floor(clamped / 60)
  const secs = Math.floor(clamped % 60)
  const tenths = Math.floor((clamped - Math.floor(clamped)) * 10)
  const base = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return showTenths ? `${base}.${tenths}` : base
}

export function joinSegmentWords(tokens: Token[], includeDeleted = false): string {
  const filtered = tokens.filter(
    (t) => t.type === 'word' && (includeDeleted || !t.deleted) && t.text.trim().length > 0
  )
  if (filtered.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < filtered.length; i++) {
    const curr = filtered[i].text.trim()
    if (i > 0) {
      const prev = filtered[i - 1].text.trim()
      if (ASCII_WORD_RE.test(prev) && ASCII_WORD_RE.test(curr)) {
        parts.push(' ')
      }
    }
    parts.push(curr)
  }
  return parts.join('')
}

export function generateRemappedSrtClient(segments: Segment[], keepRanges: KeepRange[]): string {
  if (keepRanges.length === 0) return ''
  const blocks: string[] = []
  let idx = 1

  for (const seg of segments) {
    const keptWords = seg.tokens.filter(
      (t) => !t.deleted && t.type === 'word' && t.text.trim().length > 0
    )
    if (keptWords.length === 0) continue

    const text = joinSegmentWords(keptWords)
    if (!text) continue

    const origStart = keptWords[0].start
    const origEnd = keptWords[keptWords.length - 1].end
    const newStart = remapTimestamp(origStart, keepRanges)
    let newEnd = remapTimestamp(origEnd, keepRanges)
    if (newEnd <= newStart + 0.04) {
      newEnd = Number((newStart + 0.08).toFixed(3))
    }

    blocks.push(`${idx}\n${formatSrtTime(newStart)} --> ${formatSrtTime(newEnd)}\n${text}\n`)
    idx++
  }

  return blocks.join('\n')
}

let _uidCounter = 1
export function makeUid(prefix: string): string {
  _uidCounter++
  return `${prefix}_${Date.now().toString(36)}_${_uidCounter.toString(36)}`
}

/**
 * Rebuilds silence tokens client-side whenever the user adjusts the Silence Threshold (UI 可調)
 * or splits/merges rows, preserving existing `deleted` state on silence intervals.
 */
export function rebuildSilenceTokensClient(
  segments: Segment[],
  silenceThreshold: number,
  totalDuration?: number
): Segment[] {
  const deletedSilenceMap = new Map<string, boolean>()
  const wordRows: { segId: string; words: Token[] }[] = []

  for (const seg of segments) {
    const words: Token[] = []
    for (const tok of seg.tokens) {
      if (tok.type === 'silence') {
        const key = `${Math.round(tok.start * 20)}_${Math.round(tok.end * 20)}`
        deletedSilenceMap.set(key, tok.deleted)
      } else {
        words.push({ ...tok })
      }
    }
    if (words.length > 0) {
      wordRows.push({ segId: seg.id, words })
    }
  }

  if (wordRows.length === 0) return []

  const isDeleted = (s: number, e: number): boolean => {
    const key = `${Math.round(s * 20)}_${Math.round(e * 20)}`
    return deletedSilenceMap.get(key) ?? false
  }

  const out: Segment[] = []
  let prevWordEnd: number | null = null

  for (let sIdx = 0; sIdx < wordRows.length; sIdx++) {
    const { segId, words } = wordRows[sIdx]
    const tokens: Token[] = []

    if (sIdx === 0 && words[0].start >= silenceThreshold) {
      const sStart = 0
      const sEnd = Number(words[0].start.toFixed(3))
      const gap = Number((sEnd - sStart).toFixed(3))
      tokens.push({
        id: makeUid('sil'),
        type: 'silence',
        text: `[··· ${gap.toFixed(1)}s]`,
        start: sStart,
        end: sEnd,
        deleted: isDeleted(sStart, sEnd),
      })
    }

    for (let wIdx = 0; wIdx < words.length; wIdx++) {
      const w = words[wIdx]
      if (wIdx > 0 && prevWordEnd !== null) {
        const gap = Number((w.start - prevWordEnd).toFixed(3))
        if (gap >= silenceThreshold) {
          tokens.push({
            id: makeUid('sil'),
            type: 'silence',
            text: `[··· ${gap.toFixed(1)}s]`,
            start: prevWordEnd,
            end: w.start,
            deleted: isDeleted(prevWordEnd, w.start),
          })
        }
      }
      tokens.push(w)
      prevWordEnd = w.end
    }

    if (sIdx < wordRows.length - 1) {
      const nextStart = wordRows[sIdx + 1].words[0].start
      if (prevWordEnd !== null) {
        const gap = Number((nextStart - prevWordEnd).toFixed(3))
        if (gap >= silenceThreshold) {
          tokens.push({
            id: makeUid('sil'),
            type: 'silence',
            text: `[··· ${gap.toFixed(1)}s]`,
            start: prevWordEnd,
            end: nextStart,
            deleted: isDeleted(prevWordEnd, nextStart),
          })
        }
      }
    } else if (totalDuration && prevWordEnd !== null) {
      const gap = Number((totalDuration - prevWordEnd).toFixed(3))
      if (gap >= silenceThreshold) {
        const endVal = Number(totalDuration.toFixed(3))
        tokens.push({
          id: makeUid('sil'),
          type: 'silence',
          text: `[··· ${gap.toFixed(1)}s]`,
          start: prevWordEnd,
          end: endVal,
          deleted: isDeleted(prevWordEnd, endVal),
        })
      }
    }

    out.push({ id: segId, tokens })
  }

  return out
}
