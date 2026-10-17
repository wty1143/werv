import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Clock,
  CornerDownLeft,
  Download,
  Edit3,
  FileText,
  Film,
  FolderOpen,
  Keyboard,
  Merge,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  RotateCcw,
  Scissors,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  Wand2,
  X,
  Zap,
} from 'lucide-react'
import {
  computeKeepRanges,
  formatDisplayTime,
  generateRemappedSrtClient,
  joinSegmentWords,
  makeUid,
  rebuildSilenceTokensClient,
  remapTimestamp,
  resolveVirtualPlayhead,
} from './timeline'
import {
  EditorMode,
  ExportResponse,
  ProjectMetadata,
  Segment,
  Token,
  WhisperModelName,
} from './types'

const cloneSegments = (segs: Segment[]): Segment[] =>
  segs.map((s) => ({
    id: s.id,
    tokens: s.tokens.map((t) => ({ ...t })),
  }))

export default function App() {
  // Project & ASR State
  const [project, setProject] = useState<ProjectMetadata | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [undoStack, setUndoStack] = useState<Segment[][]>([])
  const [redoStack, setRedoStack] = useState<Segment[][]>([])

  // Settings State
  const [modelName, setModelName] = useState<WhisperModelName>(
    'mlx-community/whisper-large-v3-turbo'
  )
  const [customPrompt, setCustomPrompt] = useState<string>(
    'Werv, Vrew, 剪映, Apple Silicon, 氣口'
  )
  const [silenceThreshold, setSilenceThreshold] = useState<number>(0.4)
  const [batchSilenceMin, setBatchSilenceMin] = useState<number>(0.4)
  const [paddingSec, setPaddingSec] = useState<number>(0.05)
  const [mergeGapSec, setMergeGapSec] = useState<number>(0.08)

  // Editor Mode & Selection State
  const [editorMode, setEditorMode] = useState<EditorMode>('cut')
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<string>>(new Set())
  const [anchorTokenId, setAnchorTokenId] = useState<string | null>(null)
  const [isDraggingSelect, setIsDraggingSelect] = useState<boolean>(false)
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState<string>('')

  // Playback & Virtual Timeline State
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const [playbackRate, setPlaybackRate] = useState<number>(1.0)
  const [isMuted, setIsMuted] = useState<boolean>(false)
  const [virtualCutPreview, setVirtualCutPreview] = useState<boolean>(true)
  const [showSubtitleOverlay, setShowSubtitleOverlay] = useState<boolean>(true)

  // Modals & Busy States
  const [isLoadingDemo, setIsLoadingDemo] = useState<boolean>(false)
  const [isUploading, setIsUploading] = useState<boolean>(false)
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false)
  const [isExporting, setIsExporting] = useState<boolean>(false)
  const [showAsrSettings, setShowAsrSettings] = useState<boolean>(false)
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false)
  const [exportResult, setExportResult] = useState<ExportResponse | null>(null)
  const [statusMessage, setStatusMessage] = useState<string>(
    '就緒 · 支援 Apple Silicon MLX Whisper 與 VideoToolbox 硬體加速'
  )
  const [errorBanner, setErrorBanner] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Flattened tokens list for index-based range selection & navigation
  const flatTokens = useMemo(() => {
    const list: { token: Token; segIndex: number; tokIndex: number; segId: string }[] = []
    segments.forEach((seg, sIdx) => {
      seg.tokens.forEach((tok, tIdx) => {
        list.push({ token: tok, segIndex: sIdx, tokIndex: tIdx, segId: seg.id })
      })
    })
    return list
  }, [segments])

  // Module C: Compute merged keep_ranges in real time
  const keepRanges = useMemo(() => {
    return computeKeepRanges(segments, paddingSec, mergeGapSec, project?.duration)
  }, [segments, paddingSec, mergeGapSec, project?.duration])

  // Statistics
  const stats = useMemo(() => {
    const origDur = project?.duration || 0
    const keptDur = keepRanges.reduce((acc, r) => acc + (r.end - r.start), 0)
    const savedDur = Math.max(0, origDur - keptDur)
    const savedPct = origDur > 0 ? Math.round((savedDur / origDur) * 100) : 0

    let totalWords = 0
    let deletedWords = 0
    let totalSilences = 0
    let deletedSilences = 0

    for (const seg of segments) {
      for (const tok of seg.tokens) {
        if (tok.type === 'word') {
          totalWords++
          if (tok.deleted) deletedWords++
        } else {
          totalSilences++
          if (tok.deleted) deletedSilences++
        }
      }
    }

    return {
      origDur,
      keptDur,
      savedDur,
      savedPct,
      totalWords,
      deletedWords,
      totalSilences,
      deletedSilences,
    }
  }, [project?.duration, keepRanges, segments])

  // Commit segment state changes with Undo/Redo history stack
  const commitSegments = useCallback(
    (nextSegments: Segment[]) => {
      setUndoStack((prev) => [...prev.slice(-49), cloneSegments(segments)])
      setRedoStack([])
      setSegments(nextSegments)
    },
    [segments]
  )

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return
    const previous = undoStack[undoStack.length - 1]
    setRedoStack((prev) => [...prev, cloneSegments(segments)])
    setUndoStack((prev) => prev.slice(0, -1))
    setSegments(previous)
    setStatusMessage('已復原上一步操作 (Undo)')
  }, [undoStack, segments])

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return
    const next = redoStack[redoStack.length - 1]
    setUndoStack((prev) => [...prev, cloneSegments(segments)])
    setRedoStack((prev) => prev.slice(0, -1))
    setSegments(next)
    setStatusMessage('已重做操作 (Redo)')
  }, [redoStack, segments])

  // Module C: Zero-Latency Virtual Timeline Player via requestAnimationFrame
  useEffect(() => {
    let rafId: number
    let lastSeekStamp = 0

    const tick = () => {
      const vid = videoRef.current
      if (vid) {
        const nowTime = vid.currentTime
        setCurrentTime(nowTime)

        if (!vid.paused && virtualCutPreview && keepRanges.length > 0) {
          // If browser is actively decoding from a previous seek (especially on 60/120fps video), do not re-seek!
          if (vid.seeking) {
            rafId = requestAnimationFrame(tick)
            return
          }
          const res = resolveVirtualPlayhead(nowTime, keepRanges)
          const nowPerf = performance.now()
          if (res.action === 'seek' && nowPerf - lastSeekStamp > 100) {
            lastSeekStamp = nowPerf
            vid.currentTime = res.targetTime
            setCurrentTime(res.targetTime)
          } else if (res.action === 'end' && nowPerf - lastSeekStamp > 100) {
            lastSeekStamp = nowPerf
            vid.pause()
            vid.currentTime = res.targetTime
            setCurrentTime(res.targetTime)
            setIsPlaying(false)
          }
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [keepRanges, virtualCutPreview])

  // Sync playbackRate & mute to <video>
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate
    }
  }, [playbackRate])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted
    }
  }, [isMuted])

  // Load Demo Project on first visit so user immediately sees a working Vrew project
  const handleLoadDemo = useCallback(async () => {
    setErrorBanner(null)
    setIsLoadingDemo(true)
    setStatusMessage('正在載入台灣繁中測試短片與字級時間軸...')
    try {
      const resp = await fetch('/api/demo?transcribe=true', { method: 'POST' })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.detail || '載入範例失敗')
      }
      const data: ProjectMetadata = await resp.json()
      setProject(data)
      setSegments(data.segments)
      setUndoStack([])
      setRedoStack([])
      setSelectedTokenIds(new Set())
      setSilenceThreshold(data.silence_threshold || 0.4)
      setBatchSilenceMin(data.silence_threshold || 0.4)
      setExportResult(null)
      setStatusMessage(
        `已載入「${data.filename}」· 共 ${data.segments.length} 列字幕，可點選任意字或氣口按空白鍵剪輯`
      )
    } catch (err: any) {
      setErrorBanner(err.message || '載入範例專案時發生錯誤')
    } finally {
      setIsLoadingDemo(false)
    }
  }, [])

  useEffect(() => {
    handleLoadDemo()
  }, [handleLoadDemo])

  // Upload local video file + run ASR
  const handleFileUpload = async (file: File) => {
    setErrorBanner(null)
    setIsUploading(true)
    setExportResult(null)
    setStatusMessage(`正在上傳並解析影片「${file.name}」...`)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const upResp = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      })
      if (!upResp.ok) {
        const err = await upResp.json().catch(() => ({}))
        throw new Error(err.detail || '上傳影片失敗')
      }
      const uploadedProj: ProjectMetadata = await upResp.json()
      setProject(uploadedProj)
      setSegments([])
      setUndoStack([])
      setRedoStack([])
      setIsUploading(false)

      // Automatically start MLX Whisper + Silero VAD + OpenCC transcription
      await runTranscription(uploadedProj.project_id)
    } catch (err: any) {
      setIsUploading(false)
      setErrorBanner(err.message || '影片上傳失敗')
    }
  }

  const runTranscription = async (targetProjectId?: string) => {
    const pid = targetProjectId || project?.project_id
    if (!pid) return
    setErrorBanner(null)
    setIsTranscribing(true)
    setStatusMessage(
      `正在透過 Apple Silicon (${modelName.split('/')[1]}) + Silero VAD + OpenCC (s2twp) 執行高精準度字級語音辨識...`
    )
    try {
      const resp = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: pid,
          model_name: modelName,
          custom_prompt: customPrompt,
          silence_threshold: silenceThreshold,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.detail || '語音辨識失敗')
      }
      const data: ProjectMetadata = await resp.json()
      setProject(data)
      setSegments(data.segments)
      setUndoStack([])
      setRedoStack([])
      setSelectedTokenIds(new Set())
      setShowAsrSettings(false)
      setStatusMessage(
        `語音辨識完成！共產生 ${data.segments.length} 列台灣繁中字幕與氣口標記`
      )
    } catch (err: any) {
      setErrorBanner(err.message || '語音辨識時發生錯誤')
    } finally {
      setIsTranscribing(false)
    }
  }

  // Adjust Silence Threshold dynamically in UI (預設 0.4 秒，UI 可調)
  const handleSilenceThresholdChange = (newVal: number) => {
    const clamped = Number(Math.max(0.15, Math.min(2.0, newVal)).toFixed(2))
    setSilenceThreshold(clamped)
    setBatchSilenceMin(clamped)
    if (segments.length > 0) {
      const updated = rebuildSilenceTokensClient(segments, clamped, project?.duration)
      setSegments(updated)
      setStatusMessage(`已更新氣口偵測門檻為 ${clamped.toFixed(2)} 秒`)
    }
  }

  // Toggle deleted status on selected tokens
  const toggleSelectedDeleted = useCallback(() => {
    if (selectedTokenIds.size === 0) return
    // Determine target deleted state: if any selected token is not deleted, mark all as deleted; otherwise restore all
    let anyKept = false
    for (const seg of segments) {
      for (const tok of seg.tokens) {
        if (selectedTokenIds.has(tok.id) && !tok.deleted) {
          anyKept = true
          break
        }
      }
    }
    const nextDeleted = anyKept
    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) =>
        selectedTokenIds.has(tok.id) ? { ...tok, deleted: nextDeleted } : tok
      ),
    }))
    commitSegments(nextSegments)
    setStatusMessage(
      nextDeleted
        ? `已剪除選取的 ${selectedTokenIds.size} 個字元/氣口 (預覽與匯出將自動跳過)`
        : `已還原選取的 ${selectedTokenIds.size} 個字元/氣口`
    )
  }, [selectedTokenIds, segments, commitSegments])

  // Split segment at selected token (在任一字 Token 按 Enter 可將該列拆分為兩列字幕)
  const handleSplitSegmentAtToken = useCallback(
    (targetTokenId?: string) => {
      const tokId =
        targetTokenId || (selectedTokenIds.size === 1 ? Array.from(selectedTokenIds)[0] : null)
      if (!tokId) return

      const nextSegments: Segment[] = []
      let didSplit = false

      for (const seg of segments) {
        const idx = seg.tokens.findIndex((t) => t.id === tokId)
        if (idx === -1) {
          nextSegments.push(seg)
          continue
        }

        // If token is at index > 0, split before idx; if at index 0 and row has >1 token, split after index 0
        const splitPos = idx > 0 ? idx : seg.tokens.length > 1 ? 1 : -1
        if (splitPos === -1) {
          nextSegments.push(seg)
          continue
        }

        const firstHalf = seg.tokens.slice(0, splitPos)
        const secondHalf = seg.tokens.slice(splitPos)
        nextSegments.push({ id: seg.id, tokens: firstHalf })
        nextSegments.push({ id: makeUid('seg'), tokens: secondHalf })
        didSplit = true
      }

      if (didSplit) {
        commitSegments(nextSegments)
        setStatusMessage('已將字幕列拆分為兩列 (Enter)')
      }
    },
    [selectedTokenIds, segments, commitSegments]
  )

  // Merge segment with previous segment (在列首按 Backspace 可與上一列合併)
  const handleMergeWithPreviousSegment = useCallback(
    (segIndex: number) => {
      if (segIndex <= 0 || segIndex >= segments.length) return
      const nextSegments = cloneSegments(segments)
      const prevSeg = nextSegments[segIndex - 1]
      const currSeg = nextSegments[segIndex]
      prevSeg.tokens = [...prevSeg.tokens, ...currSeg.tokens]
      nextSegments.splice(segIndex, 1)
      commitSegments(nextSegments)
      setStatusMessage(`已將第 ${segIndex + 1} 列合併至上一列`)
    },
    [segments, commitSegments]
  )

  // Batch Silence Operations (一鍵選取/刪除所有 >= X 秒的氣口)
  const handleSelectSilencesAbove = (minSec: number) => {
    const matched = new Set<string>()
    for (const seg of segments) {
      for (const tok of seg.tokens) {
        if (tok.type === 'silence' && tok.end - tok.start >= minSec - 1e-4) {
          matched.add(tok.id)
        }
      }
    }
    setSelectedTokenIds(matched)
    setStatusMessage(`已選取 ${matched.size} 個 >= ${minSec.toFixed(1)} 秒的空白氣口`)
  }

  const handleDeleteSilencesAbove = (minSec: number) => {
    let count = 0
    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) => {
        if (tok.type === 'silence' && tok.end - tok.start >= minSec - 1e-4) {
          count++
          return { ...tok, deleted: true }
        }
        return tok
      }),
    }))
    if (count > 0) {
      commitSegments(nextSegments)
      setStatusMessage(`已一鍵剪除 ${count} 個 >= ${minSec.toFixed(1)} 秒的空白氣口！`)
    } else {
      setStatusMessage(`目前沒有 >= ${minSec.toFixed(1)} 秒的氣口`)
    }
  }

  const handleRestoreAllTokens = () => {
    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) => ({ ...tok, deleted: false })),
    }))
    commitSegments(nextSegments)
    setStatusMessage('已還原所有被剪除的字元與氣口')
  }

  // Inline Text Edit (改錯字：僅修改 Token 的 text 屬性，不改變其 start/end 與 deleted 狀態)
  const startEditingToken = (tok: Token) => {
    if (tok.type !== 'word') return
    setEditingTokenId(tok.id)
    setEditingText(tok.text)
  }

  const commitEditingToken = () => {
    if (!editingTokenId) return
    const trimmed = editingText.trim()
    if (trimmed.length > 0) {
      const nextSegments = segments.map((seg) => ({
        ...seg,
        tokens: seg.tokens.map((tok) =>
          tok.id === editingTokenId ? { ...tok, text: trimmed } : tok
        ),
      }))
      commitSegments(nextSegments)
      setStatusMessage(`已修正文字為「${trimmed}」（保留原始時間軸與剪輯狀態）`)
    }
    setEditingTokenId(null)
    setEditingText('')
  }

  // Click / Drag token selection & video seek
  const handleTokenMouseDown = (
    e: React.MouseEvent,
    tok: Token,
    flatIdx: number
  ) => {
    if (editingTokenId === tok.id) return

    // Seek video to clicked token's start and play (點擊任意字 Token，播放器立即 seek 到該 Token 的 start 並開始播放)
    if (videoRef.current) {
      videoRef.current.currentTime = tok.start
      setCurrentTime(tok.start)
      if (videoRef.current.paused) {
        videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {})
      }
    }

    if (editorMode === 'edit' && tok.type === 'word') {
      startEditingToken(tok)
      return
    }

    if (e.shiftKey && anchorTokenId) {
      const anchorIdx = flatTokens.findIndex((item) => item.token.id === anchorTokenId)
      if (anchorIdx !== -1) {
        const startIdx = Math.min(anchorIdx, flatIdx)
        const endIdx = Math.max(anchorIdx, flatIdx)
        const rangeIds = new Set<string>()
        for (let i = startIdx; i <= endIdx; i++) {
          rangeIds.add(flatTokens[i].token.id)
        }
        setSelectedTokenIds(rangeIds)
        return
      }
    }

    if (e.metaKey || e.ctrlKey) {
      setSelectedTokenIds((prev) => {
        const next = new Set(prev)
        if (next.has(tok.id)) next.delete(tok.id)
        else next.add(tok.id)
        return next
      })
      setAnchorTokenId(tok.id)
      return
    }

    setIsDraggingSelect(true)
    setAnchorTokenId(tok.id)
    setSelectedTokenIds(new Set([tok.id]))
  }

  const handleTokenMouseEnter = (flatIdx: number) => {
    if (!isDraggingSelect || !anchorTokenId) return
    const anchorIdx = flatTokens.findIndex((item) => item.token.id === anchorTokenId)
    if (anchorIdx === -1) return
    const startIdx = Math.min(anchorIdx, flatIdx)
    const endIdx = Math.max(anchorIdx, flatIdx)
    const rangeIds = new Set<string>()
    for (let i = startIdx; i <= endIdx; i++) {
      rangeIds.add(flatTokens[i].token.id)
    }
    setSelectedTokenIds(rangeIds)
  }

  useEffect(() => {
    const handleMouseUp = () => setIsDraggingSelect(false)
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [])

  // Global Keyboard Shortcuts (Module B)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts when typing in an input or textarea
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) handleRedo()
        else handleUndo()
        return
      }

      // Enter: Split subtitle row at selected token
      if (e.key === 'Enter' && selectedTokenIds.size === 1) {
        e.preventDefault()
        handleSplitSegmentAtToken()
        return
      }

      // Backspace at first token of a row -> Merge with previous row; otherwise toggle deleted
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (e.key === 'Backspace' && selectedTokenIds.size === 1) {
          const onlyId = Array.from(selectedTokenIds)[0]
          const found = flatTokens.find((item) => item.token.id === onlyId)
          if (found && found.tokIndex === 0 && found.segIndex > 0) {
            handleMergeWithPreviousSegment(found.segIndex)
            return
          }
        }
        if (selectedTokenIds.size > 0) {
          toggleSelectedDeleted()
        }
        return
      }

      // Space: If tokens are selected in Cut mode, toggle their deleted status; else toggle Play/Pause
      if (e.key === ' ') {
        e.preventDefault()
        if (selectedTokenIds.size > 0 && editorMode === 'cut') {
          toggleSelectedDeleted()
        } else if (videoRef.current) {
          if (videoRef.current.paused) {
            videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {})
          } else {
            videoRef.current.pause()
            setIsPlaying(false)
          }
        }
        return
      }

      // Escape: Clear token selection
      if (e.key === 'Escape') {
        setSelectedTokenIds(new Set())
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    selectedTokenIds,
    editorMode,
    flatTokens,
    handleUndo,
    handleRedo,
    handleSplitSegmentAtToken,
    handleMergeWithPreviousSegment,
    toggleSelectedDeleted,
  ])

  // Currently active segment & token for video subtitle overlay
  const activePlaybackInfo = useMemo(() => {
    let activeSeg: Segment | null = null
    let activeTokenId: string | null = null

    for (const seg of segments) {
      if (seg.tokens.length === 0) continue
      const rowStart = seg.tokens[0].start
      const rowEnd = seg.tokens[seg.tokens.length - 1].end
      if (currentTime >= rowStart - 0.05 && currentTime <= rowEnd + 0.08) {
        activeSeg = seg
      }
      for (const tok of seg.tokens) {
        if (currentTime >= tok.start - 0.02 && currentTime <= tok.end + 0.02) {
          activeTokenId = tok.id
          activeSeg = seg
          break
        }
      }
    }
    return { activeSeg, activeTokenId }
  }, [segments, currentTime])

  // Module D: Export Video (VideoToolbox) + Remapped SRT
  const handleExport = async () => {
    if (!project) return
    setErrorBanner(null)
    setIsExporting(true)
    setStatusMessage(
      '正在透過 Apple VideoToolbox 硬體加速編碼 MP4 (含 15ms 音訊防爆音淡入淡出) 並重算 SRT 時間軸...'
    )
    try {
      const resp = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: project.project_id,
          segments,
          padding: paddingSec,
          merge_gap: mergeGapSec,
          fade_ms: 15.0,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.detail || '匯出失敗')
      }
      const data: ExportResponse = await resp.json()
      setExportResult(data)
      setStatusMessage(
        `匯出成功！原片長 ${data.original_duration.toFixed(1)}s ➔ 剪輯後 ${data.exported_duration.toFixed(1)}s（省下 ${data.saved_seconds.toFixed(1)}s）`
      )
    } catch (err: any) {
      setErrorBanner(err.message || '匯出影片時發生錯誤')
    } finally {
      setIsExporting(false)
    }
  }

  // Client-side instant SRT download
  const handleInstantSrtDownload = () => {
    const srtText = generateRemappedSrtClient(segments, keepRanges)
    const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stem = project?.filename.replace(/\.[^.]+$/, '') || 'werv_subtitles'
    a.href = url
    a.download = `${stem}_remapped.srt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const togglePlayPause = () => {
    const vid = videoRef.current
    if (!vid) return
    if (vid.paused) {
      vid.play().then(() => setIsPlaying(true)).catch(() => {})
    } else {
      vid.pause()
      setIsPlaying(false)
    }
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0c0e14] text-slate-100 select-none overflow-hidden font-sans">
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFileUpload(f)
          e.target.value = ''
        }}
      />

      {/* TOP STUDIO HEADER BAR (Vrew Desktop Style) */}
      <header className="h-14 px-4 bg-[#141822] border-b border-slate-800/90 flex items-center justify-between shrink-0 z-20">
        {/* Brand & Project Title */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5 bg-gradient-to-r from-cyan-500/15 to-indigo-500/15 border border-cyan-500/30 px-3 py-1.5 rounded-lg">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-sm shadow-cyan-500/30">
              <Scissors className="w-3.5 h-3.5 text-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold tracking-tight text-sm text-white">
                  Vrew
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                  Werv Local Pro
                </span>
              </div>
            </div>
          </div>

          {/* Open File & Demo Buttons */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || isTranscribing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700/90 text-slate-200 text-xs font-medium border border-slate-700/80 transition"
          >
            <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
            <span>匯入影片</span>
          </button>

          <button
            onClick={handleLoadDemo}
            disabled={isLoadingDemo || isTranscribing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/50 hover:bg-slate-800 text-slate-300 text-xs border border-slate-700/60 transition"
            title="載入內建台灣繁中範例短片"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>載入範例</span>
          </button>

          {project && (
            <div className="hidden xl:flex items-center gap-2 pl-2 border-l border-slate-800 text-xs text-slate-400">
              <Film className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-slate-200 font-medium max-w-[180px] truncate">
                {project.filename}
              </span>
              <span className="text-slate-500">
                ({project.width}×{project.height} · {project.fps}fps)
              </span>
            </div>
          )}
        </div>

        {/* Center Editing Mode Switcher & Undo/Redo */}
        <div className="flex items-center gap-2">
          {/* Mode Toggle: Cut vs Edit Text */}
          <div className="flex items-center bg-[#0c0e14] p-1 rounded-lg border border-slate-800">
            <button
              onClick={() => {
                setEditorMode('cut')
                setEditingTokenId(null)
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition ${
                editorMode === 'cut'
                  ? 'bg-cyan-500 text-slate-950 shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>剪輯刪除模式</span>
            </button>
            <button
              onClick={() => setEditorMode('edit')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition ${
                editorMode === 'edit'
                  ? 'bg-indigo-500 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>改錯字模式</span>
            </button>
          </div>

          {/* Undo / Redo */}
          <div className="flex items-center bg-[#0c0e14] p-1 rounded-lg border border-slate-800">
            <button
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              className="p-1.5 rounded hover:bg-slate-800 text-slate-300 disabled:opacity-30 disabled:pointer-events-none transition"
              title="復原 (⌘Z)"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              className="p-1.5 rounded hover:bg-slate-800 text-slate-300 disabled:opacity-30 disabled:pointer-events-none transition"
              title="重做 (⌘⇧Z)"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* ASR Settings Trigger */}
          <button
            onClick={() => setShowAsrSettings((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
              showAsrSettings
                ? 'bg-indigo-500/20 border-indigo-400/50 text-indigo-200'
                : 'bg-slate-800/70 hover:bg-slate-800 border-slate-700/70 text-slate-300'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5 text-indigo-400" />
            <span>AI 辨識與參數設定</span>
          </button>

          {/* Shortcuts Guide */}
          <button
            onClick={() => setShowShortcutsModal(true)}
            className="p-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 border border-slate-700/70 text-slate-400 hover:text-slate-200 transition"
            title="鍵盤快捷鍵說明"
          >
            <Keyboard className="w-4 h-4" />
          </button>
        </div>

        {/* Right Export Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleInstantSrtDownload}
            disabled={segments.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 text-xs font-medium border border-slate-700 transition disabled:opacity-40"
            title="立即匯出重算時間軸後的 UTF-8 .srt 字幕檔"
          >
            <FileText className="w-3.5 h-3.5 text-emerald-400" />
            <span>僅下載 SRT</span>
          </button>

          <button
            onClick={handleExport}
            disabled={!project || segments.length === 0 || isExporting}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-slate-950 font-bold text-xs shadow-md shadow-cyan-500/20 transition disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <progress
                  aria-label="正在匯出影片"
                  className="loading-spinner"
                  style={
                    {
                      '--size': '14px',
                      '--thickness': '2px',
                      '--spinner-color': '#0f172a',
                    } as React.CSSProperties
                  }
                />
                <span>硬體加速匯出中...</span>
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 fill-current" />
                <span>匯出影片 + SRT</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* ASR & SILENCE SETTINGS DRAWER (Module A Configuration) */}
      {showAsrSettings && (
        <div className="bg-[#181d2b] border-b border-slate-700/80 px-6 py-4 shadow-xl z-10 animate-in fade-in duration-150">
          <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-5 items-end">
            {/* Model Select */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                MLX Whisper 模型選擇 (Apple Silicon 原生加速)
              </label>
              <select
                value={modelName}
                onChange={(e) => setModelName(e.target.value as WhisperModelName)}
                className="w-full bg-[#0c0e14] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
              >
                <option value="mlx-community/whisper-large-v3-turbo">
                  mlx-community/whisper-large-v3-turbo (推薦：極速 + 高準度)
                </option>
                <option value="mlx-community/whisper-large-v3">
                  mlx-community/whisper-large-v3 (最高精準度完整版)
                </option>
              </select>
            </div>

            {/* Custom Initial Prompt */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                自訂專有名詞 Prompt (提高特定人名/品牌/術語辨識率)
              </label>
              <input
                type="text"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="例如：剪映, Vrew, 台積電, 產品名稱..."
                className="w-full bg-[#0c0e14] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
              />
            </div>

            {/* Padding & Re-run ASR */}
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  字尾保護 Padding：{paddingSec.toFixed(2)}s
                </label>
                <input
                  type="range"
                  min={0.0}
                  max={0.15}
                  step={0.01}
                  value={paddingSec}
                  onChange={(e) => setPaddingSec( parseFloat(e.target.value) )}
                  className="w-full accent-cyan-400"
                />
              </div>
              <button
                onClick={() => runTranscription()}
                disabled={!project || isTranscribing}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-semibold text-xs transition disabled:opacity-40"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isTranscribing ? 'animate-spin' : ''}`} />
                <span>重新辨識語音</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ERROR BANNER */}
      {errorBanner && (
        <div className="bg-rose-500/15 border-b border-rose-500/40 px-4 py-2 flex items-center justify-between text-xs text-rose-200">
          <span>⚠️ {errorBanner}</span>
          <button
            onClick={() => setErrorBanner(null)}
            className="p-0.5 hover:bg-rose-500/20 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* MAIN DUAL-PANE WORKSPACE */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* LEFT PANE: NATIVE HTML5 VIDEO PLAYER + VIRTUAL TIMELINE MONITOR */}
        <div className="w-[44%] min-w-[380px] max-w-[640px] bg-[#10131c] border-r border-slate-800/90 flex flex-col justify-between p-4 shrink-0">
          {/* Top Video Preview Header */}
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-300">
                零延遲虛擬時間軸預覽
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-medium">
                rAF 60fps 即時跳躍
              </span>
            </div>

            {/* Toggle Virtual Cut Skip */}
            <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
              <input
                type="checkbox"
                checked={virtualCutPreview}
                onChange={(e) => setVirtualCutPreview(e.target.checked)}
                className="rounded accent-cyan-400"
              />
              <span>預覽自動跳過刪除區段</span>
            </label>
          </div>

          {/* Video Viewport Box */}
          <div className="relative flex-1 bg-black rounded-xl overflow-hidden border border-slate-800/90 flex items-center justify-center shadow-2xl group">
            {project ? (
              <>
                <video
                  ref={videoRef}
                  src={project.video_url}
                  className="max-h-full max-w-full object-contain cursor-pointer"
                  onClick={togglePlayPause}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  playsInline
                />

                {/* Vrew-Style Live Broadcast Subtitle Overlay on Video */}
                {showSubtitleOverlay && activePlaybackInfo.activeSeg && (
                  <div className="absolute bottom-6 inset-x-6 flex justify-center pointer-events-none">
                    <div className="bg-black/80 backdrop-blur-md px-4 py-2 rounded-lg border border-white/10 shadow-lg max-w-[92%] text-center">
                      <div className="flex flex-wrap items-center justify-center gap-0.5 text-base md:text-lg font-bold tracking-wide">
                        {activePlaybackInfo.activeSeg.tokens
                          .filter((t) => !t.deleted && t.type === 'word')
                          .map((tok) => {
                            const isCurrent = tok.id === activePlaybackInfo.activeTokenId
                            return (
                              <span
                                key={tok.id}
                                className={
                                  isCurrent
                                    ? 'text-cyan-300 scale-105 transition-transform'
                                    : 'text-white'
                                }
                              >
                                {tok.text}
                              </span>
                            )
                          })}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center p-8 text-slate-500 text-sm">
                尚未載入影片，請點擊上方「匯入影片」或「載入範例」
              </div>
            )}

            {/* Loading Overlay for Upload / ASR */}
            {(isUploading || isTranscribing || isLoadingDemo) && (
              <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm flex flex-col items-center justify-center gap-3 p-6 text-center z-10">
                <progress
                  aria-label="AI 語音處理中"
                  className="loading-spinner"
                  style={{ '--size': '42px', '--thickness': '3.5px' } as React.CSSProperties}
                />
                <div className="text-sm font-semibold text-white">
                  {isUploading
                    ? '正在上傳影片檔案...'
                    : isLoadingDemo
                    ? '正在準備台灣繁中教學短片...'
                    : 'MLX Whisper + Silero VAD 正在對齊每個中文字時間軸...'}
                </div>
                <p className="text-xs text-slate-400 max-w-xs">
                  已啟用 OpenCC (s2twp) 台灣繁體與慣用語轉換，並自動防止靜音區間時間軸漂移
                </p>
              </div>
            )}
          </div>

          {/* VISUAL TIMELINE BAR (Keep Ranges vs Cut Ranges) */}
          <div className="mt-3 bg-[#151926] p-3 rounded-xl border border-slate-800/90">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-cyan-300 font-semibold text-xs">
                  {formatDisplayTime(currentTime)}
                </span>
                <span>/</span>
                <span className="font-mono">{formatDisplayTime(stats.origDur)}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 inline-block" />
                  保留區段 ({keepRanges.length})
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-rose-500/70 inline-block" />
                  已剪除 ({stats.savedDur.toFixed(1)}s / -{stats.savedPct}%)
                </span>
              </div>
            </div>

            {/* Interactive Scrubber with Keep Ranges visualization */}
            <div
              className="relative h-6 bg-[#0c0e14] rounded-lg overflow-hidden border border-slate-800 cursor-pointer cut-stripe-bg"
              onClick={(e) => {
                if (!videoRef.current || !stats.origDur) return
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                const target = ratio * stats.origDur
                videoRef.current.currentTime = target
                setCurrentTime(target)
              }}
            >
              {/* Kept intervals rendered as solid cyan bars */}
              {stats.origDur > 0 &&
                keepRanges.map((r, i) => {
                  const leftPct = (r.start / stats.origDur) * 100
                  const widthPct = ((r.end - r.start) / stats.origDur) * 100
                  return (
                    <div
                      key={i}
                      style={{ left: `${leftPct}%`, width: `${ Math.max(0.4, widthPct) }%` }}
                      className="absolute inset-y-0 bg-cyan-500/35 border-x border-cyan-400/50"
                    />
                  )
                })}

              {/* Playhead Indicator */}
              {stats.origDur > 0 && (
                <div
                  style={{ left: `${Math.min(100, (currentTime / stats.origDur) * 100)}%` }}
                  className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_8px_#fff] z-10 pointer-events-none"
                />
              )}
            </div>

            {/* Player Transport Controls */}
            <div className="flex items-center justify-between mt-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={togglePlayPause}
                  disabled={!project}
                  className="flex items-center justify-center w-9 h-9 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition shadow-sm disabled:opacity-40"
                  title="播放 / 暫停 (空白鍵)"
                >
                  {isPlaying ? (
                    <Pause className="w-4 h-4 fill-current" />
                  ) : (
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  )}
                </button>

                <button
                  onClick={() => {
                    if (videoRef.current) {
                      const startTarget = keepRanges[0]?.start ?? 0
                      videoRef.current.currentTime = startTarget
                      setCurrentTime(startTarget)
                    }
                  }}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                  title="回到開頭"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>

                <button
                  onClick={() => setIsMuted((m) => !m)}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                  title="靜音切換"
                >
                  {isMuted ? (
                    <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              {/* Duration Comparison Pill */}
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#0c0e14] border border-slate-800 text-xs">
                <Clock className="w-3.5 h-3.5 text-cyan-400" />
                <span className="text-slate-400">粗剪後片長：</span>
                <span className="font-mono font-bold text-cyan-300">
                  {formatDisplayTime(stats.keptDur)}
                </span>
              </div>

              {/* Speed & Subtitle Overlay Controls */}
              <div className="flex items-center gap-1.5">
                <select
                  value={playbackRate}
                  onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none"
                  title="播放倍速"
                >
                  <option value={0.75}>0.75x</option>
                  <option value={1}>1.0x</option>
                  <option value={1.25}>1.25x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2.0x</option>
                </select>

                <button
                  onClick={() => setShowSubtitleOverlay((v) => !v)}
                  className={`px-2 py-1 rounded-lg text-xs font-medium border transition ${
                    showSubtitleOverlay
                      ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                  title="切換畫面字幕預覽"
                >
                  CC 字幕
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT PANE: VREW-STYLE SENTENCE ROWS + CHARACTER/SILENCE BLOCK EDITOR */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#0c0e14]">
          {/* Right Pane Top Action Bar (Batch Silence & Selection Actions) */}
          <div className="px-5 py-3 bg-[#121621] border-b border-slate-800/90 flex flex-wrap items-center justify-between gap-3 shrink-0">
            {/* Batch Silence Controls */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 bg-[#0c0e14] px-2.5 py-1 rounded-lg border border-slate-800 text-xs">
                <span className="text-amber-400 font-semibold">氣口門檻</span>
                <input
                  type="number"
                  min={0.2}
                  max={2.0}
                  step={0.1}
                  value={silenceThreshold}
                  onChange={(e) =>
                    handleSilenceThresholdChange(parseFloat(e.target.value) || 0.4)
                  }
                  className="w-14 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-center font-mono text-amber-300 focus:outline-none focus:border-amber-400"
                />
                <span className="text-slate-400">秒</span>
              </div>

              <button
                onClick={() => handleSelectSilencesAbove(batchSilenceMin)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-medium transition"
              >
                <span>選取 &ge; {batchSilenceMin.toFixed(1)}s 氣口</span>
              </button>

              <button
                onClick={() => handleDeleteSilencesAbove(batchSilenceMin)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shadow-sm transition"
              >
                <Wand2 className="w-3.5 h-3.5" />
                <span>一鍵刪除所有 &ge; {batchSilenceMin.toFixed(1)}s 氣口</span>
              </button>

              {(stats.deletedWords > 0 || stats.deletedSilences > 0) && (
                <button
                  onClick={handleRestoreAllTokens}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>全部還原</span>
                </button>
              )}
            </div>

            {/* Selection Contextual Actions */}
            <div className="flex items-center gap-2">
              {selectedTokenIds.size > 0 ? (
                <>
                  <span className="text-xs text-cyan-300 font-medium">
                    已選取 {selectedTokenIds.size} 個積木
                  </span>
                  <button
                    onClick={toggleSelectedDeleted}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-xs font-medium transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>切換剪除/還原 (Space / Del)</span>
                  </button>
                  {selectedTokenIds.size === 1 && (
                    <button
                      onClick={() => handleSplitSegmentAtToken()}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs transition"
                    >
                      <CornerDownLeft className="w-3.5 h-3.5 text-cyan-400" />
                      <span>在此拆行 (Enter)</span>
                    </button>
                  )}
                </>
              ) : (
                <span className="text-xs text-slate-400">
                  💡 提示：點擊或拖曳選取字元/氣口，按 <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-200 border border-slate-700">Space</kbd> 或 <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-200 border border-slate-700">Delete</kbd> 剪片；雙擊單字可改錯字
                </span>
              )}
            </div>
          </div>

          {/* TRANSCRIPT ROWS SCROLLER */}
          <div className="flex-1 overflow-y-auto transcript-scroller p-5 space-y-3">
            {segments.map((seg, segIdx) => {
              const rowStart = seg.tokens[0]?.start ?? 0
              const rowEnd = seg.tokens[seg.tokens.length - 1]?.end ?? 0
              const isRowActive = activePlaybackInfo.activeSeg?.id === seg.id
              const previewSrtLine = joinSegmentWords(seg.tokens, false)
              const allRowDeleted =
                seg.tokens.length > 0 && seg.tokens.every((t) => t.deleted)

              return (
                <div
                  key={seg.id}
                  className={`group rounded-xl border transition-all duration-150 p-3.5 ${
                    isRowActive
                      ? 'bg-[#161c2e] border-cyan-500/50 shadow-lg shadow-cyan-950/20'
                      : allRowDeleted
                      ? 'bg-[#10121a]/60 border-slate-800/50 opacity-60'
                      : 'bg-[#131722] border-slate-800/80 hover:border-slate-700'
                  }`}
                >
                  {/* Segment Row Header */}
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                          isRowActive
                            ? 'bg-cyan-500 text-slate-950'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        #{String(segIdx + 1).padStart(2, '0')}
                      </span>

                      <button
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = rowStart
                            setCurrentTime(rowStart)
                            videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {})
                          }
                        }}
                        className="text-xs font-mono text-slate-400 hover:text-cyan-300 transition flex items-center gap-1"
                        title="點擊從此列開頭播放"
                      >
                        <span>{formatDisplayTime(rowStart)}</span>
                        <span>→</span>
                        <span>{formatDisplayTime(rowEnd)}</span>
                      </button>

                      {/* Preview of final SRT line text */}
                      {previewSrtLine ? (
                        <span className="text-xs text-slate-400 bg-[#0c0e14] px-2.5 py-0.5 rounded border border-slate-800/80 truncate max-w-md">
                          SRT: {previewSrtLine}
                        </span>
                      ) : (
                        <span className="text-xs text-rose-400/80 italic">
                          (整列已剪除，將不輸出至 SRT)
                        </span>
                      )}
                    </div>

                    {/* Row Quick Actions */}
                    <div className="flex items-center gap-1.5 opacity-70 group-hover:opacity-100 transition">
                      {segIdx > 0 && (
                        <button
                          onClick={() => handleMergeWithPreviousSegment(segIdx)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-[11px] transition"
                          title="與上一列字幕合併 (列首按 Backspace)"
                        >
                          <Merge className="w-3 h-3 text-indigo-400" />
                          <span>合併上列</span>
                        </button>
                      )}

                      <button
                        onClick={() => {
                          const targetDeleted = !allRowDeleted
                          const next = segments.map((s, idx) =>
                            idx === segIdx
                              ? {
                                  ...s,
                                  tokens: s.tokens.map((t) => ({
                                    ...t,
                                    deleted: targetDeleted,
                                  })),
                                }
                              : s
                          )
                          commitSegments(next)
                        }}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800/80 hover:bg-rose-500/20 text-slate-300 hover:text-rose-300 text-[11px] transition"
                      >
                        <Scissors className="w-3 h-3" />
                        <span>{allRowDeleted ? '還原整列' : '剪除整列'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Vrew-Style Token Blocks (字元積木 + 氣口積木) */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {seg.tokens.map((tok) => {
                      const flatIdx = flatTokens.findIndex(
                        (item) => item.token.id === tok.id
                      )
                      const isSelected = selectedTokenIds.has(tok.id)
                      const isPlayingNow = activePlaybackInfo.activeTokenId === tok.id
                      const isEditingThis = editingTokenId === tok.id

                      if (isEditingThis) {
                        return (
                          <div
                            key={tok.id}
                            className="inline-flex items-center bg-indigo-950 border-2 border-indigo-400 rounded-lg px-2 py-1 shadow-lg"
                          >
                            <input
                              type="text"
                              value={editingText}
                              autoFocus
                              onChange={(e) => setEditingText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  commitEditingToken()
                                } else if (e.key === 'Escape') {
                                  setEditingTokenId(null)
                                }
                              }}
                              onBlur={commitEditingToken}
                              className="w-16 bg-transparent text-white font-bold text-sm focus:outline-none text-center"
                            />
                            <button
                              onMouseDown={(e) => {
                                e.preventDefault()
                                commitEditingToken()
                              }}
                              className="ml-1 text-emerald-400 hover:text-emerald-300"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )
                      }

                      if (tok.type === 'silence') {
                        return (
                          <div
                            key={tok.id}
                            onMouseDown={(e) => handleTokenMouseDown(e, tok, flatIdx)}
                            onMouseEnter={() => handleTokenMouseEnter(flatIdx)}
                            title={`氣口區間：${tok.start.toFixed(2)}s - ${tok.end.toFixed(2)}s (點擊或按空白鍵剪除)`}
                            className={`cursor-pointer px-2.5 py-1.5 rounded-lg text-xs font-mono font-medium border transition-all flex items-center gap-1 ${
                              tok.deleted
                                ? 'line-through opacity-35 bg-rose-950/25 border-rose-500/30 text-rose-300'
                                : isSelected
                                ? 'bg-amber-400/25 border-amber-400 text-amber-200 ring-2 ring-amber-400/30'
                                : isPlayingNow
                                ? 'bg-amber-500/30 border-amber-300 text-amber-100 scale-105'
                                : 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30 text-amber-300'
                            }`}
                          >
                            <span>{tok.text}</span>
                          </div>
                        )
                      }

                      // Word / Character Token Block
                      return (
                        <div
                          key={tok.id}
                          onMouseDown={(e) => handleTokenMouseDown(e, tok, flatIdx)}
                          onMouseEnter={() => handleTokenMouseEnter(flatIdx)}
                          onDoubleClick={() => startEditingToken(tok)}
                          title={`${tok.text} (${tok.start.toFixed(2)}s - ${tok.end.toFixed(2)}s) · 雙擊可改錯字`}
                          className={`cursor-pointer min-w-[34px] px-2.5 py-1.5 rounded-lg text-sm font-semibold border transition-all text-center relative ${
                            tok.deleted
                              ? 'line-through opacity-35 bg-rose-950/25 border-rose-500/30 text-rose-300'
                              : isSelected
                              ? 'bg-cyan-500/25 border-cyan-400 text-white ring-2 ring-cyan-400/30 shadow-sm'
                              : isPlayingNow
                              ? 'bg-cyan-400 text-slate-950 border-cyan-300 shadow-md shadow-cyan-500/25 scale-105'
                              : 'bg-[#1b2132] hover:bg-[#232b42] border-slate-700/80 text-slate-100'
                          }`}
                        >
                          <span>{tok.text}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* BOTTOM STUDIO STATUS BAR */}
      <footer className="h-8 px-4 bg-[#141822] border-t border-slate-800/90 flex items-center justify-between text-[11px] text-slate-400 shrink-0">
        <div className="flex items-center gap-2 truncate">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-slate-300 truncate">{statusMessage}</span>
        </div>

        <div className="flex items-center gap-4 shrink-0 font-mono">
          <span>
            總字數: <strong className="text-slate-200">{stats.totalWords}</strong> (已刪{' '}
            <strong className="text-rose-400">{stats.deletedWords}</strong>)
          </span>
          <span>
            氣口數: <strong className="text-amber-300">{stats.totalSilences}</strong> (已刪{' '}
            <strong className="text-rose-400">{stats.deletedSilences}</strong>)
          </span>
          <span>
            原片 {formatDisplayTime(stats.origDur)} ➔ 剪輯後{' '}
            <strong className="text-cyan-300">{formatDisplayTime(stats.keptDur)}</strong>
          </span>
        </div>
      </footer>

      {/* EXPORT RESULT MODAL (MP4 + Remapped SRT + One-Click Bundle Download) */}
      {exportResult && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="bg-[#151925] border border-slate-700 rounded-2xl max-w-4xl w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                  <Zap className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">
                    Apple VideoToolbox 硬體加速匯出完成！
                  </h3>
                  <p className="text-xs text-slate-400">
                    已完成 H.264 15Mbps 硬體重新編碼、15ms 音訊接合防爆音處理與 SRT 時間軸重算
                  </p>
                </div>
              </div>
              <button
                onClick={() => setExportResult(null)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Export Summary Cards */}
            <div className="grid grid-cols-4 gap-3">
              <div className="bg-[#0c0e14] p-3 rounded-xl border border-slate-800">
                <div className="text-[11px] text-slate-400">原始影片長度</div>
                <div className="text-lg font-mono font-bold text-slate-200">
                  {exportResult.original_duration.toFixed(2)}s
                </div>
              </div>
              <div className="bg-[#0c0e14] p-3 rounded-xl border border-slate-800">
                <div className="text-[11px] text-slate-400">粗剪後影片長度</div>
                <div className="text-lg font-mono font-bold text-cyan-400">
                  {exportResult.exported_duration.toFixed(2)}s
                </div>
              </div>
              <div className="bg-[#0c0e14] p-3 rounded-xl border border-slate-800">
                <div className="text-[11px] text-slate-400">精準剪除時間</div>
                <div className="text-lg font-mono font-bold text-emerald-400">
                  -{exportResult.saved_seconds.toFixed(2)}s
                </div>
              </div>
              <div className="bg-[#0c0e14] p-3 rounded-xl border border-slate-800">
                <div className="text-[11px] text-slate-400">保留時間軸區段</div>
                <div className="text-lg font-mono font-bold text-indigo-400">
                  {exportResult.keep_ranges.length} 段
                </div>
              </div>
            </div>

            {/* Preview Exported Video & Remapped SRT side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-[#0c0e14] rounded-xl border border-slate-800 p-3 flex flex-col">
                <span className="text-xs font-semibold text-slate-300 mb-2">
                  🎬 匯出後 MP4 成品預覽
                </span>
                <video
                  src={exportResult.mp4_url}
                  controls
                  className="w-full h-48 object-contain bg-black rounded-lg"
                />
              </div>

              <div className="bg-[#0c0e14] rounded-xl border border-slate-800 p-3 flex flex-col">
                <span className="text-xs font-semibold text-slate-300 mb-2">
                  📝 重算時間軸後之 UTF-8 SRT 字幕預覽
                </span>
                <pre className="flex-1 h-48 overflow-y-auto transcript-scroller text-xs font-mono text-slate-300 bg-slate-950/70 p-3 rounded-lg whitespace-pre-wrap">
                  {exportResult.srt_content || '(無字幕內容)'}
                </pre>
              </div>
            </div>

            {/* Download Buttons */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <a
                href={exportResult.srt_url}
                download
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
              >
                <FileText className="w-4 h-4 text-emerald-400" />
                <span>下載 .SRT 字幕檔</span>
              </a>

              <a
                href={exportResult.mp4_url}
                download
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
              >
                <Film className="w-4 h-4 text-cyan-400" />
                <span>下載粗剪 .MP4</span>
              </a>

              <a
                href={exportResult.bundle_url}
                download
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-slate-950 font-bold text-xs shadow-lg shadow-cyan-500/25 transition"
              >
                <Download className="w-4 h-4" />
                <span>一鍵打包下載 (MP4 + SRT .zip) 供匯入剪映</span>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* KEYBOARD SHORTCUTS MODAL */}
      {showShortcutsModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="bg-[#151925] border border-slate-700 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Keyboard className="w-4 h-4 text-cyan-400" />
                <span>Vrew / Werv 鍵盤快捷鍵一覽</span>
              </h3>
              <button
                onClick={() => setShowShortcutsModal(false)}
                className="p-1 rounded hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-xs">
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">剪除 / 還原選取的字或氣口</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  Delete / Space
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">修正同音錯字（不剪掉畫面）</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  雙擊單字
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">將目前字幕列拆分為兩列</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  Enter
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">在列首與上一列字幕合併</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  列首按 Backspace
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">連續範圍選取多個字/氣口</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  拖曳滑鼠 / Shift+點擊
                </kbd>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-slate-300">復原 / 重做 (Undo / Redo)</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  ⌘Z / ⌘⇧Z
                </kbd>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
