import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  CornerDownLeft,
  Download,
  Edit3,
  Eye,
  EyeOff,
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
  Search,
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

const DEFAULT_FILLER_WORDS = [
  '那個', '就是', '然後', '就是說', '對啊', '這個', '其實', '基本上',
  '嗯', '啊', '呃', '喔', '欸', '啦', '吧', '呀', '咧',
]
import {
  computeKeepRanges,
  formatDisplayTime,
  generateRemappedSrtClient,
  getEffectiveCaption,
  joinSegmentWords,
  makeUid,
  rebuildSilenceTokensClient,
  remapTimestamp,
  resolveVirtualPlayhead,
} from './timeline'
import {
  ExportResponse,
  ProjectMetadata,
  Segment,
  Token,
  WhisperModelName,
} from './types'

const cloneSegments = (segs: Segment[]): Segment[] =>
  segs.map((s) => ({
    id: s.id,
    caption: s.caption,
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

  // Selection & Caret State
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<string>>(new Set())
  const [anchorTokenId, setAnchorTokenId] = useState<string | null>(null)
  const [isDraggingSelect, setIsDraggingSelect] = useState<boolean>(false)
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState<string>('')
  // Word-style caret states
  const [cursorTokenId, setCursorTokenId] = useState<string | null>(null)
  const [isAtRowStart, setIsAtRowStart] = useState<boolean>(false)

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

  // Phase 1: Shorten Silence & Filler Words States
  const [showShortenModal, setShowShortenModal] = useState<boolean>(false)
  const [shortenMinSec, setShortenMinSec] = useState<number>(0.5)
  const [shortenTargetSec, setShortenTargetSec] = useState<number>(0.25)
  const [showFillerModal, setShowFillerModal] = useState<boolean>(false)
  const [customFillerTerms, setCustomFillerTerms] = useState<string[]>([])
  const [customFillerInput, setCustomFillerInput] = useState<string>('')
  const [checkedFillerWords, setCheckedFillerWords] = useState<Set<string>>(new Set())

  // Phase 2: Phrase Edit, Find & Replace, and Collapse Deleted States
  const [showPhraseModal, setShowPhraseModal] = useState<boolean>(false)
  const [phraseInput, setPhraseInput] = useState<string>('')
  const [showFindReplace, setShowFindReplace] = useState<boolean>(false)
  const [findQuery, setFindQuery] = useState<string>('')
  const [replaceQuery, setReplaceQuery] = useState<string>('')
  const [findMatchIdx, setFindMatchIdx] = useState<number>(0)
  const [isCollapsedDeleted, setIsCollapsedDeleted] = useState<boolean>(false)
  const findInputRef = useRef<HTMLInputElement | null>(null)
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

  // Resolve current cursor flat index
  const cursorFlatIndex = useMemo(() => {
    if (!cursorTokenId) return null
    const idx = flatTokens.findIndex((item) => item.token.id === cursorTokenId)
    return idx !== -1 ? idx : null
  }, [flatTokens, cursorTokenId])

  const scrollTokenIntoView = useCallback((tokId: string) => {
    const el = document.getElementById(`tok-${tokId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
  }, [])

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
      setCursorTokenId(null)
      setIsAtRowStart(false)
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
      setCursorTokenId(null)
      setIsAtRowStart(false)
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
      let newSplitTokenId: string | null = null

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
        nextSegments.push({ id: seg.id, tokens: firstHalf, caption: null })
        nextSegments.push({ id: makeUid('seg'), tokens: secondHalf, caption: null })
        didSplit = true
        if (secondHalf.length > 0) {
          newSplitTokenId = secondHalf[0].id
        }
      }

      if (didSplit) {
        commitSegments(nextSegments)
        if (newSplitTokenId) {
          setCursorTokenId(newSplitTokenId)
          setSelectedTokenIds(new Set([newSplitTokenId]))
          setAnchorTokenId(newSplitTokenId)
          setIsAtRowStart(true)
          scrollTokenIntoView(newSplitTokenId)
        }
        setStatusMessage('已將字幕列拆分為兩列 (Enter)')
      }
    },
    [selectedTokenIds, segments, commitSegments, scrollTokenIntoView]
  )

  // Merge segment with previous segment (在列首按 Backspace 可與上一列合併)
  const handleMergeWithPreviousSegment = useCallback(
    (segIndex: number) => {
      if (segIndex <= 0 || segIndex >= segments.length) return
      const nextSegments = cloneSegments(segments)
      const prevSeg = nextSegments[segIndex - 1]
      const currSeg = nextSegments[segIndex]
      const junctionToken =
        prevSeg.tokens.length > 0 ? prevSeg.tokens[prevSeg.tokens.length - 1] : null

      let mergedCaption: string | null = null
      if (
        (prevSeg.caption !== null && prevSeg.caption !== undefined) ||
        (currSeg.caption !== null && currSeg.caption !== undefined)
      ) {
        mergedCaption = `${getEffectiveCaption(prevSeg)} ${getEffectiveCaption(currSeg)}`.trim()
      }
      prevSeg.caption = mergedCaption
      prevSeg.tokens = [...prevSeg.tokens, ...currSeg.tokens]
      nextSegments.splice(segIndex, 1)
      commitSegments(nextSegments)
      if (junctionToken) {
        setCursorTokenId(junctionToken.id)
        setSelectedTokenIds(new Set([junctionToken.id]))
        setAnchorTokenId(junctionToken.id)
        setIsAtRowStart(false)
        scrollTokenIntoView(junctionToken.id)
      }
      setStatusMessage(`已將第 ${segIndex + 1} 列合併至上一列`)
    },
    [segments, commitSegments, scrollTokenIntoView]
  )

  // Update custom subtitle caption for a segment
  const handleUpdateSegmentCaption = useCallback(
    (segId: string, newCaption: string) => {
      const next = segments.map((s) =>
        s.id === segId ? { ...s, caption: newCaption } : s
      )
      commitSegments(next)
    },
    [segments, commitSegments]
  )

  // Reset segment caption to auto-sync with video cut words
  const handleResetSegmentCaption = useCallback(
    (segId: string) => {
      const next = segments.map((s) =>
        s.id === segId ? { ...s, caption: null } : s
      )
      commitSegments(next)
      setStatusMessage('已將此列字幕重新同步回 Video Cuts 保留字塊')
    },
    [segments, commitSegments]
  )

  // Quick toggle cut/restore for a single token (Corner hover button)
  const handleToggleSingleTokenDeleted = useCallback(
    (tokId: string) => {
      let willDelete = true
      for (const seg of segments) {
        for (const tok of seg.tokens) {
          if (tok.id === tokId) {
            willDelete = !tok.deleted
            break
          }
        }
      }
      const next = segments.map((seg) => ({
        ...seg,
        tokens: seg.tokens.map((tok) =>
          tok.id === tokId ? { ...tok, deleted: willDelete } : tok
        ),
      }))
      commitSegments(next)
      setStatusMessage(willDelete ? '已剪除該項目' : '已還原該項目')
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

  // Restore all tokens (both deleted tokens and shortened silences back to full duration)
  const handleRestoreAllTokens = () => {
    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) => {
        if (tok.type === 'silence') {
          const gap = tok.end - tok.start
          return {
            ...tok,
            deleted: false,
            keep_duration: null,
            text: `[··· ${gap.toFixed(1)}s]`,
          }
        }
        return { ...tok, deleted: false }
      }),
    }))
    commitSegments(nextSegments)
    setStatusMessage('已還原所有被剪除的字元與氣口（包含恢復縮短之氣口為原始長度）')
  }

  // Restore selected or cursor token(s), including clearing shortened silence back to full duration
  const handleRestoreSelectedTokens = useCallback(() => {
    let targetIds = Array.from(selectedTokenIds)
    if (targetIds.length === 0 && cursorTokenId) {
      targetIds = [cursorTokenId]
    }
    if (targetIds.length === 0) return

    const idSet = new Set(targetIds)
    let restoredShortenCount = 0
    let restoredDeletedCount = 0

    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) => {
        if (idSet.has(tok.id)) {
          if (tok.deleted) restoredDeletedCount++
          if (tok.type === 'silence') {
            const gap = tok.end - tok.start
            if (tok.keep_duration != null) restoredShortenCount++
            return {
              ...tok,
              deleted: false,
              keep_duration: null,
              text: `[··· ${gap.toFixed(1)}s]`,
            }
          }
          return { ...tok, deleted: false }
        }
        return tok
      }),
    }))

    commitSegments(nextSegments)
    if (restoredShortenCount > 0 && restoredDeletedCount === 0) {
      setStatusMessage(`已將選取的氣口恢復為完整原始長度`)
    } else {
      setStatusMessage(`已還原 ${targetIds.length} 個字元/氣口 (R)`)
    }
  }, [selectedTokenIds, cursorTokenId, segments, commitSegments])

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

  // Phase 1: Batch Shorten Silences (縮短氣口：將 >= minSec 的氣口濃縮保留為 targetKeep 秒)
  const handleBatchShortenSilences = (minSec: number, targetKeep: number) => {
    let count = 0
    let savedTotal = 0
    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) => {
        if (tok.type === 'silence') {
          const gap = tok.end - tok.start
          if (gap >= minSec - 1e-4 && targetKeep < gap) {
            count++
            savedTotal += gap - targetKeep
            return {
              ...tok,
              deleted: false,
              keep_duration: targetKeep,
              text: `[··· ${gap.toFixed(1)}s ➔ ${targetKeep.toFixed(1)}s]`,
            }
          }
        }
        return tok
      }),
    }))
    if (count > 0) {
      commitSegments(nextSegments)
      setStatusMessage(
        `已將 ${count} 個 >= ${minSec.toFixed(1)}s 的氣口縮短保留為 ${targetKeep.toFixed(2)}s (共省下約 ${savedTotal.toFixed(1)}s)`
      )
    } else {
      setStatusMessage(`未找到符合條件 (>= ${minSec.toFixed(1)}s) 的長氣口`)
    }
    setShowShortenModal(false)
  }

  // Shorten single selected silence token
  const handleShortenSelectedSilence = (targetKeep = 0.25) => {
    if (selectedTokenIds.size === 0) return
    const idSet = selectedTokenIds
    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) => {
        if (idSet.has(tok.id) && tok.type === 'silence') {
          const gap = tok.end - tok.start
          return {
            ...tok,
            deleted: false,
            keep_duration: targetKeep,
            text: `[··· ${gap.toFixed(1)}s ➔ ${targetKeep.toFixed(1)}s]`,
          }
        }
        return tok
      }),
    }))
    commitSegments(nextSegments)
    setStatusMessage(`已將選取的氣口縮短保留為 ${targetKeep}s`)
  }

  // Phase 1: Scan all detected filler words in current segments
  const detectedFillerList = useMemo(() => {
    const allTerms = Array.from(new Set([...DEFAULT_FILLER_WORDS, ...customFillerTerms]))
    const results: { term: string; count: number; tokenIds: string[] }[] = []

    for (const term of allTerms) {
      const cleanTerm = term.trim()
      if (!cleanTerm) continue
      const termLen = cleanTerm.length
      const matchedIds: string[] = []

      for (const seg of segments) {
        const words = seg.tokens.filter((t) => !t.deleted && t.type === 'word')
        for (let i = 0; i <= words.length - termLen; i++) {
          const sliceText = words.slice(i, i + termLen).map((w) => w.text).join('')
          if (sliceText === cleanTerm) {
            for (let k = 0; k < termLen; k++) {
              matchedIds.push(words[i + k].id)
            }
          }
        }
      }

      if (matchedIds.length > 0) {
        results.push({
          term: cleanTerm,
          count: Math.round(matchedIds.length / termLen),
          tokenIds: matchedIds,
        })
      }
    }
    return results.sort((a, b) => b.count - a.count)
  }, [segments, customFillerTerms])

  // Select checked filler words in the transcript
  const handleSelectFillerWords = () => {
    const toSelect = new Set<string>()
    for (const item of detectedFillerList) {
      if (checkedFillerWords.has(item.term)) {
        item.tokenIds.forEach((id) => toSelect.add(id))
      }
    }
    if (toSelect.size > 0) {
      setSelectedTokenIds(toSelect)
      setStatusMessage(`已在文稿中高亮選取 ${toSelect.size} 個贅字/語助詞`)
      setShowFillerModal(false)
    } else {
      setStatusMessage('請先勾選欲選取的贅字詞彙')
    }
  }

  // Delete checked filler words directly
  const handleDeleteFillerWords = () => {
    const toDelete = new Set<string>()
    let termsCount = 0
    for (const item of detectedFillerList) {
      if (checkedFillerWords.has(item.term)) {
        item.tokenIds.forEach((id) => toDelete.add(id))
        termsCount += item.count
      }
    }
    if (toDelete.size === 0) {
      setStatusMessage('請先勾選欲剪除的贅字詞彙')
      return
    }

    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) =>
        toDelete.has(tok.id) ? { ...tok, deleted: true } : tok
      ),
    }))
    commitSegments(nextSegments)
    setStatusMessage(`已一鍵剪除 ${termsCount} 處共 ${toDelete.size} 個贅字與語助詞！`)
    setShowFillerModal(false)
  }

  // Phase 2: Open Multi-token Phrase Edit Modal / Bar
  const handleOpenPhraseModal = () => {
    if (selectedTokenIds.size === 0) return
    const selItems = flatTokens.filter((item) => selectedTokenIds.has(item.token.id))
    if (selItems.length === 0) return
    const combined = selItems.map((item) => item.token.text).join('')
    setPhraseInput(combined)
    setShowPhraseModal(true)
  }

  // Commit Phrase Edit: Replaces the selected tokens in their segment with new characters
  const handleCommitPhraseEdit = (newText: string) => {
    const trimmed = newText.trim()
    if (!trimmed || selectedTokenIds.size === 0) {
      setShowPhraseModal(false)
      return
    }

    const selItems = flatTokens.filter((item) => selectedTokenIds.has(item.token.id))
    if (selItems.length === 0) {
      setShowPhraseModal(false)
      return
    }

    const targetSegId = selItems[0].segId
    const firstTok = selItems[0].token
    const lastTok = selItems[selItems.length - 1].token
    const spanStart = firstTok.start
    const spanEnd = Math.max(spanStart + 0.05, lastTok.end)
    const totalSpan = spanEnd - spanStart

    const chars = Array.from(trimmed)
    const charDur = Number((totalSpan / chars.length).toFixed(3))

    const newTokens: Token[] = chars.map((ch, idx) => {
      const s = Number((spanStart + idx * charDur).toFixed(3))
      const e = idx === chars.length - 1 ? spanEnd : Number((s + charDur).toFixed(3))
      return {
        id: makeUid('tok'),
        type: 'word',
        text: ch,
        start: s,
        end: e,
        deleted: false,
      }
    })

    const nextSegments = segments.map((seg) => {
      if (seg.id !== targetSegId) return seg
      const nextToks: Token[] = []
      let inserted = false
      for (const tok of seg.tokens) {
        if (selectedTokenIds.has(tok.id)) {
          if (!inserted) {
            nextToks.push(...newTokens)
            inserted = true
          }
        } else {
          nextToks.push(tok)
        }
      }
      return { ...seg, tokens: nextToks }
    })

    commitSegments(nextSegments)
    setSelectedTokenIds(new Set(newTokens.map((t) => t.id)))
    setCursorTokenId(newTokens[newTokens.length - 1].id)
    setStatusMessage(`已將文字修改為「${trimmed}」（時間軸已自動均分重算）`)
    setShowPhraseModal(false)
  }

  // Phase 2: Find & Replace match list across all segments
  const searchMatches = useMemo(() => {
    if (!findQuery.trim()) return []
    const q = findQuery.trim()
    const qLen = q.length
    const list: {
      segIndex: number
      segId: string
      tokenIds: string[]
      start: number
      text: string
    }[] = []

    segments.forEach((seg, sIdx) => {
      const words = seg.tokens.filter((t) => t.type === 'word')
      for (let i = 0; i <= words.length - qLen; i++) {
        const sliceText = words.slice(i, i + qLen).map((w) => w.text).join('')
        if (sliceText.toLowerCase().includes(q.toLowerCase())) {
          const tokenIds = words.slice(i, i + qLen).map((w) => w.id)
          list.push({
            segIndex: sIdx,
            segId: seg.id,
            tokenIds,
            start: words[i].start,
            text: sliceText,
          })
        }
      }
    })
    return list
  }, [segments, findQuery])

  const handleFindNext = () => {
    if (searchMatches.length === 0) return
    const nextIdx = (findMatchIdx + 1) % searchMatches.length
    setFindMatchIdx(nextIdx)
    const target = searchMatches[nextIdx]
    setSelectedTokenIds(new Set(target.tokenIds))
    setCursorTokenId(target.tokenIds[0])
    scrollTokenIntoView(target.tokenIds[0])
    if (videoRef.current) {
      videoRef.current.currentTime = target.start
      setCurrentTime(target.start)
    }
  }

  const handleFindPrev = () => {
    if (searchMatches.length === 0) return
    const prevIdx = (findMatchIdx - 1 + searchMatches.length) % searchMatches.length
    setFindMatchIdx(prevIdx)
    const target = searchMatches[prevIdx]
    setSelectedTokenIds(new Set(target.tokenIds))
    setCursorTokenId(target.tokenIds[0])
    scrollTokenIntoView(target.tokenIds[0])
    if (videoRef.current) {
      videoRef.current.currentTime = target.start
      setCurrentTime(target.start)
    }
  }

  const handleSelectAllMatches = () => {
    if (searchMatches.length === 0) return
    const allIds = new Set<string>()
    searchMatches.forEach((m) => m.tokenIds.forEach((id) => allIds.add(id)))
    setSelectedTokenIds(allIds)
    setStatusMessage(`已全選 ${searchMatches.length} 處符合項目，可按 Backspace 一鍵剪除！`)
  }

  const handleReplaceCurrentMatch = () => {
    if (searchMatches.length === 0) return
    const currentMatch = searchMatches[findMatchIdx % searchMatches.length]
    if (!currentMatch) return

    const trimmed = replaceQuery.trim()
    const targetSegId = currentMatch.segId
    const targetIds = new Set(currentMatch.tokenIds)

    const nextSegments = segments.map((seg) => {
      if (seg.id !== targetSegId) return seg
      const selToks = seg.tokens.filter((t) => targetIds.has(t.id))
      if (selToks.length === 0) return seg
      const spanStart = selToks[0].start
      const spanEnd = selToks[selToks.length - 1].end
      const dur = Math.max(0.04 * trimmed.length, spanEnd - spanStart)

      const chars = Array.from(trimmed)
      const charDur = Number((dur / chars.length).toFixed(3))
      const newTokens: Token[] = chars.map((ch, idx) => ({
        id: makeUid('tok'),
        type: 'word',
        text: ch,
        start: Number((spanStart + idx * charDur).toFixed(3)),
        end: idx === chars.length - 1 ? spanEnd : Number((spanStart + (idx + 1) * charDur).toFixed(3)),
        deleted: false,
      }))

      const nextToks: Token[] = []
      let inserted = false
      for (const tok of seg.tokens) {
        if (targetIds.has(tok.id)) {
          if (!inserted) {
            nextToks.push(...newTokens)
            inserted = true
          }
        } else {
          nextToks.push(tok)
        }
      }
      return { ...seg, tokens: nextToks }
    })

    commitSegments(nextSegments)
    setStatusMessage(`已將符合項目取代為「${trimmed}」`)
  }

  const handleReplaceAllMatches = () => {
    if (searchMatches.length === 0) return
    const trimmed = replaceQuery.trim()
    if (!trimmed) return

    const segMatchesMap = new Map<string, typeof searchMatches>()
    for (const m of searchMatches) {
      const arr = segMatchesMap.get(m.segId) || []
      arr.push(m)
      segMatchesMap.set(m.segId, arr)
    }

    const nextSegments = segments.map((seg) => {
      const matchesInSeg = segMatchesMap.get(seg.id)
      if (!matchesInSeg || matchesInSeg.length === 0) return seg

      let currentToks = [...seg.tokens]
      for (const m of matchesInSeg) {
        const targetIds = new Set(m.tokenIds)
        const selToks = currentToks.filter((t) => targetIds.has(t.id))
        if (selToks.length === 0) continue
        const spanStart = selToks[0].start
        const spanEnd = selToks[selToks.length - 1].end
        const dur = Math.max(0.04 * trimmed.length, spanEnd - spanStart)
        const chars = Array.from(trimmed)
        const charDur = Number((dur / chars.length).toFixed(3))
        const newTokens: Token[] = chars.map((ch, idx) => ({
          id: makeUid('tok'),
          type: 'word',
          text: ch,
          start: Number((spanStart + idx * charDur).toFixed(3)),
          end: idx === chars.length - 1 ? spanEnd : Number((spanStart + (idx + 1) * charDur).toFixed(3)),
          deleted: false,
        }))

        const rebuilt: Token[] = []
        let inserted = false
        for (const tok of currentToks) {
          if (targetIds.has(tok.id)) {
            if (!inserted) {
              rebuilt.push(...newTokens)
              inserted = true
            }
          } else {
            rebuilt.push(tok)
          }
        }
        currentToks = rebuilt
      }
      return { ...seg, tokens: currentToks }
    })

    const totalCount = searchMatches.length
    commitSegments(nextSegments)
    setStatusMessage(`已成功批量取代全片 ${totalCount} 處符合項目為「${trimmed}」！`)
    setShowFindReplace(false)
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

    // Set cursor position to clicked token
    setCursorTokenId(tok.id)
    setIsAtRowStart(false)

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
    if (flatTokens[flatIdx]) {
      setCursorTokenId(flatTokens[flatIdx].token.id)
      setIsAtRowStart(false)
    }
  }

  useEffect(() => {
    const handleMouseUp = () => setIsDraggingSelect(false)
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [])

  // Word-Style Backspace: Continuous backward deletion & row merge at start
  const handleWordStyleBackspace = useCallback(() => {
    if (flatTokens.length === 0) return

    // 1. Multi-token range selection: delete all selected tokens
    if (selectedTokenIds.size > 1) {
      const selectedIndices: number[] = []
      flatTokens.forEach((item, idx) => {
        if (selectedTokenIds.has(item.token.id)) {
          selectedIndices.push(idx)
        }
      })
      if (selectedIndices.length === 0) return

      const minIdx = Math.min(...selectedIndices)
      const count = selectedTokenIds.size

      // Mark all selected as deleted = true
      const nextSegments = segments.map((seg) => ({
        ...seg,
        tokens: seg.tokens.map((tok) =>
          selectedTokenIds.has(tok.id) ? { ...tok, deleted: true } : tok
        ),
      }))
      commitSegments(nextSegments)

      // Move cursor right before the deleted block
      const targetIdx = Math.max(0, minIdx - 1)
      if (flatTokens[targetIdx]) {
        const targetTok = flatTokens[targetIdx].token
        setCursorTokenId(targetTok.id)
        setSelectedTokenIds(new Set([targetTok.id]))
        setAnchorTokenId(targetTok.id)
        setIsAtRowStart(minIdx === 0)
        scrollTokenIntoView(targetTok.id)
        if (videoRef.current) {
          videoRef.current.currentTime = targetTok.start
          setCurrentTime(targetTok.start)
        }
      } else {
        setSelectedTokenIds(new Set())
        setCursorTokenId(null)
      }
      setStatusMessage(`已剪除選取的 ${count} 個字元/氣口`)
      return
    }

    // 2. Single token cursor mode:
    let currIdx = cursorFlatIndex
    if (currIdx === null || currIdx < 0 || currIdx >= flatTokens.length) {
      if (selectedTokenIds.size === 1) {
        const onlyId = Array.from(selectedTokenIds)[0]
        const foundIdx = flatTokens.findIndex((item) => item.token.id === onlyId)
        if (foundIdx !== -1) currIdx = foundIdx
      }
    }

    if (currIdx === null || currIdx < 0 || currIdx >= flatTokens.length) return
    const currentItem = flatTokens[currIdx]

    // Case A: Cursor is at row start (left border of first token) -> Merge with previous row
    if (isAtRowStart) {
      if (currentItem.segIndex > 0) {
        handleMergeWithPreviousSegment(currentItem.segIndex)
      }
      return
    }

    // Case B: Cursor at currentItem -> mark deleted = true (continuous delete, no toggling!)
    const targetTokenId = currentItem.token.id
    const nextSegments = segments.map((seg) => ({
      ...seg,
      tokens: seg.tokens.map((tok) =>
        tok.id === targetTokenId ? { ...tok, deleted: true } : tok
      ),
    }))
    commitSegments(nextSegments)

    if (currentItem.tokIndex > 0) {
      // Step cursor left to previous token in this row
      const nextIdx = currIdx - 1
      const prevTok = flatTokens[nextIdx].token
      setCursorTokenId(prevTok.id)
      setIsAtRowStart(false)
      setSelectedTokenIds(new Set([prevTok.id]))
      setAnchorTokenId(prevTok.id)
      scrollTokenIntoView(prevTok.id)
      if (videoRef.current) {
        videoRef.current.currentTime = prevTok.start
        setCurrentTime(prevTok.start)
      }
    } else {
      // Deleted token 0 of this row -> Caret moves to left border (row start)
      setIsAtRowStart(true)
      setCursorTokenId(targetTokenId)
      setSelectedTokenIds(new Set([targetTokenId]))
      setAnchorTokenId(targetTokenId)
    }

    setStatusMessage(`已剪除「${currentItem.token.text}」，游標往左推進`)
  }, [
    flatTokens,
    selectedTokenIds,
    cursorFlatIndex,
    isAtRowStart,
    segments,
    commitSegments,
    handleMergeWithPreviousSegment,
    scrollTokenIntoView,
  ])

  // Word-Style Forward Delete (Delete key)
  const handleWordStyleForwardDelete = useCallback(() => {
    if (flatTokens.length === 0) return

    if (selectedTokenIds.size > 1) {
      handleWordStyleBackspace()
      return
    }

    let currIdx = cursorFlatIndex
    if (currIdx === null || currIdx < 0 || currIdx >= flatTokens.length) {
      if (selectedTokenIds.size === 1) {
        const onlyId = Array.from(selectedTokenIds)[0]
        const foundIdx = flatTokens.findIndex((item) => item.token.id === onlyId)
        if (foundIdx !== -1) currIdx = foundIdx
      }
    }

    if (currIdx === null || currIdx < 0 || currIdx >= flatTokens.length) return

    if (isAtRowStart) {
      // Forward delete deletes the token directly ahead of cursor (which is token 0)
      const targetTokenId = flatTokens[currIdx].token.id
      const nextSegments = segments.map((seg) => ({
        ...seg,
        tokens: seg.tokens.map((tok) =>
          tok.id === targetTokenId ? { ...tok, deleted: true } : tok
        ),
      }))
      commitSegments(nextSegments)
      setIsAtRowStart(false)
      setStatusMessage(`已向後剪除「${flatTokens[currIdx].token.text}」`)
      return
    }

    // Forward delete deletes the token to the right of cursor
    if (currIdx + 1 < flatTokens.length) {
      const nextTok = flatTokens[currIdx + 1].token
      const nextSegments = segments.map((seg) => ({
        ...seg,
        tokens: seg.tokens.map((tok) =>
          tok.id === nextTok.id ? { ...tok, deleted: true } : tok
        ),
      }))
      commitSegments(nextSegments)
      setStatusMessage(`已向後剪除「${nextTok.text}」`)
    }
  }, [
    flatTokens,
    selectedTokenIds,
    cursorFlatIndex,
    isAtRowStart,
    segments,
    commitSegments,
    handleWordStyleBackspace,
  ])

  // Global Keyboard Shortcuts (Module B + Word-Style Caret Navigation)
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

      // Enter: Split subtitle row at cursor or selected token
      if (e.key === 'Enter') {
        e.preventDefault()
        let targetId: string | null = null
        if (cursorFlatIndex !== null && flatTokens[cursorFlatIndex]) {
          targetId = flatTokens[cursorFlatIndex].token.id
        } else if (selectedTokenIds.size === 1) {
          targetId = Array.from(selectedTokenIds)[0]
        }
        if (targetId) {
          handleSplitSegmentAtToken(targetId)
        }
        return
      }

      // Backspace: Word-style continuous backward deletion & row merge at start
      if (e.key === 'Backspace') {
        e.preventDefault()
        handleWordStyleBackspace()
        return
      }

      // Delete key: Forward Delete
      if (e.key === 'Delete') {
        e.preventDefault()
        handleWordStyleForwardDelete()
        return
      }

      // ArrowLeft: Navigate left
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (flatTokens.length === 0) return
        const currIdx = cursorFlatIndex ?? 0
        if (e.shiftKey) {
          const newIdx = Math.max(0, currIdx - 1)
          const targetTok = flatTokens[newIdx]?.token
          if (targetTok) {
            setCursorTokenId(targetTok.id)
            setIsAtRowStart(false)
            const anchorIdx = anchorTokenId
              ? flatTokens.findIndex((it) => it.token.id === anchorTokenId)
              : currIdx
            const sIdx = Math.min(anchorIdx, newIdx)
            const eIdx = Math.max(anchorIdx, newIdx)
            const rangeIds = new Set<string>()
            for (let i = sIdx; i <= eIdx; i++) {
              rangeIds.add(flatTokens[i].token.id)
            }
            setSelectedTokenIds(rangeIds)
            scrollTokenIntoView(targetTok.id)
            if (videoRef.current) {
              videoRef.current.currentTime = targetTok.start
              setCurrentTime(targetTok.start)
            }
          }
          return
        }

        if (isAtRowStart) {
          if (currIdx > 0) {
            const prevIdx = currIdx - 1
            const prevTok = flatTokens[prevIdx].token
            setCursorTokenId(prevTok.id)
            setIsAtRowStart(false)
            setSelectedTokenIds(new Set([prevTok.id]))
            setAnchorTokenId(prevTok.id)
            scrollTokenIntoView(prevTok.id)
            if (videoRef.current) {
              videoRef.current.currentTime = prevTok.start
              setCurrentTime(prevTok.start)
            }
          }
          return
        }

        const currentItem = flatTokens[currIdx]
        if (currentItem && currentItem.tokIndex === 0) {
          setIsAtRowStart(true)
        } else if (currIdx > 0) {
          const prevIdx = currIdx - 1
          const prevTok = flatTokens[prevIdx].token
          setCursorTokenId(prevTok.id)
          setIsAtRowStart(false)
          setSelectedTokenIds(new Set([prevTok.id]))
          setAnchorTokenId(prevTok.id)
          scrollTokenIntoView(prevTok.id)
          if (videoRef.current) {
            videoRef.current.currentTime = prevTok.start
            setCurrentTime(prevTok.start)
          }
        }
        return
      }

      // ArrowRight: Navigate right
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (flatTokens.length === 0) return
        const currIdx = cursorFlatIndex ?? 0
        if (e.shiftKey) {
          const newIdx = Math.min(flatTokens.length - 1, currIdx + 1)
          const targetTok = flatTokens[newIdx]?.token
          if (targetTok) {
            setCursorTokenId(targetTok.id)
            setIsAtRowStart(false)
            const anchorIdx = anchorTokenId
              ? flatTokens.findIndex((it) => it.token.id === anchorTokenId)
              : currIdx
            const sIdx = Math.min(anchorIdx, newIdx)
            const eIdx = Math.max(anchorIdx, newIdx)
            const rangeIds = new Set<string>()
            for (let i = sIdx; i <= eIdx; i++) {
              rangeIds.add(flatTokens[i].token.id)
            }
            setSelectedTokenIds(rangeIds)
            scrollTokenIntoView(targetTok.id)
            if (videoRef.current) {
              videoRef.current.currentTime = targetTok.start
              setCurrentTime(targetTok.start)
            }
          }
          return
        }

        if (isAtRowStart) {
          setIsAtRowStart(false)
          return
        }

        if (currIdx < flatTokens.length - 1) {
          const nextIdx = currIdx + 1
          const nextTok = flatTokens[nextIdx].token
          setCursorTokenId(nextTok.id)
          setIsAtRowStart(false)
          setSelectedTokenIds(new Set([nextTok.id]))
          setAnchorTokenId(nextTok.id)
          scrollTokenIntoView(nextTok.id)
          if (videoRef.current) {
            videoRef.current.currentTime = nextTok.start
            setCurrentTime(nextTok.start)
          }
        }
        return
      }

      // ArrowUp / ArrowDown: Row-to-row navigation
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (flatTokens.length === 0) return
        const currIdx = cursorFlatIndex ?? 0
        const curr = flatTokens[currIdx]
        if (!curr) return
        const targetSegIdx = e.key === 'ArrowUp' ? curr.segIndex - 1 : curr.segIndex + 1
        if (targetSegIdx >= 0 && targetSegIdx < segments.length) {
          const targetSeg = segments[targetSegIdx]
          if (targetSeg.tokens.length > 0) {
            const targetTokIndex = Math.min(curr.tokIndex, targetSeg.tokens.length - 1)
            const targetTok = targetSeg.tokens[targetTokIndex]
            setCursorTokenId(targetTok.id)
            setIsAtRowStart(false)
            setSelectedTokenIds(new Set([targetTok.id]))
            setAnchorTokenId(targetTok.id)
            scrollTokenIntoView(targetTok.id)
            if (videoRef.current) {
              videoRef.current.currentTime = targetTok.start
              setCurrentTime(targetTok.start)
            }
          }
        }
        return
      }

      // Find & Replace: Cmd+F / Ctrl+F
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setShowFindReplace((prev) => {
          const next = !prev
          if (next) {
            setTimeout(() => findInputRef.current?.focus(), 60)
          }
          return next
        })
        return
      }

      // Multi-token phrase edit: E key
      if (e.key.toLowerCase() === 'e' && !e.metaKey && !e.ctrlKey) {
        if (selectedTokenIds.size > 0) {
          e.preventDefault()
          handleOpenPhraseModal()
          return
        }
      }

      // R key: Restore deleted token(s) or restore shortened silences back to original duration
      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        handleRestoreSelectedTokens()
        return
      }

      // Space: Toggle Play/Pause when single cursor or no selection; toggle cut/restore if multiple selected
      if (e.key === ' ') {
        e.preventDefault()
        if (selectedTokenIds.size > 1) {
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

      // Escape: Close modals, search bar, or clear token selection
      if (e.key === 'Escape') {
        if (showFindReplace) {
          setShowFindReplace(false)
          return
        }
        if (showPhraseModal) {
          setShowPhraseModal(false)
          return
        }
        if (showShortenModal) {
          setShowShortenModal(false)
          return
        }
        if (showFillerModal) {
          setShowFillerModal(false)
          return
        }
        setSelectedTokenIds(new Set())
        setCursorTokenId(null)
        setIsAtRowStart(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    selectedTokenIds,
    cursorTokenId,
    cursorFlatIndex,
    isAtRowStart,
    anchorTokenId,
    flatTokens,
    segments,
    handleUndo,
    handleRedo,
    handleSplitSegmentAtToken,
    handleWordStyleBackspace,
    handleWordStyleForwardDelete,
    toggleSelectedDeleted,
    commitSegments,
    scrollTokenIntoView,
    showFindReplace,
    showPhraseModal,
    showShortenModal,
    showFillerModal,
    handleOpenPhraseModal,
    handleRestoreSelectedTokens,
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
      <header className="h-14 px-4 bg-[#141722] border-b border-[#232838] flex items-center justify-between shrink-0 z-20 gap-3 overflow-x-auto whitespace-nowrap select-none">
        {/* Brand & Project Title */}
        <div className="flex items-center gap-2.5 shrink-0">
          {/* Vrew Brand Logo */}
          <div className="flex items-center gap-2 pr-1 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-[#00d287] flex items-center justify-center shadow-sm shadow-emerald-500/20">
              <Scissors className="w-4 h-4 text-slate-950 stroke-[2.5]" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-extrabold tracking-tight text-base text-white font-sans">
                Vrew
              </span>
              <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                Studio
              </span>
            </div>
          </div>

          <div className="h-4 w-px bg-slate-800 shrink-0" />

          {/* Open File & Demo Buttons */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || isTranscribing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1c2130] hover:bg-[#252c40] text-slate-200 text-xs font-medium border border-slate-700/80 transition shrink-0 whitespace-nowrap"
          >
            <FolderOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>匯入影片</span>
          </button>

          <button
            onClick={handleLoadDemo}
            disabled={isLoadingDemo || isTranscribing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1c2130]/60 hover:bg-[#1c2130] text-slate-300 text-xs border border-slate-700/60 transition shrink-0 whitespace-nowrap"
            title="載入內建台灣繁中範例短片"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>載入範例</span>
          </button>

          {project && (
            <div className="hidden lg:flex items-center gap-2 px-2.5 py-1 rounded-md bg-[#0c0e14] border border-slate-800/90 text-xs text-slate-400 shrink-0 whitespace-nowrap">
              <Film className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span className="text-slate-200 font-medium max-w-[200px] truncate" title={project.filename}>
                {project.filename}
              </span>
              <span className="text-slate-500 font-mono text-[11px]">
                {project.width}×{project.height} · {project.fps}fps
              </span>
            </div>
          )}
        </div>

        {/* Center Editing Mode Switcher & Tools */}
        <div className="flex items-center gap-2 shrink-0">

          {/* Undo / Redo */}
          <div className="flex items-center bg-[#0c0e14] p-0.5 rounded-lg border border-slate-800 shrink-0">
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

          {/* ASR Settings Button */}
          <button
            onClick={() => setShowAsrSettings((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition shrink-0 whitespace-nowrap ${
              showAsrSettings
                ? 'bg-indigo-500/20 border-indigo-400/50 text-indigo-200'
                : 'bg-[#1c2130] hover:bg-[#252c40] border-slate-700/80 text-slate-300'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span>辨識設定</span>
          </button>

          {/* Shortcuts Guide */}
          <button
            onClick={() => setShowShortcutsModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1c2130] hover:bg-[#252c40] border border-slate-700/80 text-slate-300 hover:text-white transition shrink-0 text-xs"
            title="查看完整鍵盤快捷鍵一覽"
          >
            <Keyboard className="w-3.5 h-3.5 text-cyan-400" />
            <span>快捷鍵說明</span>
          </button>

          {/* Find & Replace Button */}
          <button
            onClick={() => {
              setShowFindReplace((v) => {
                const next = !v
                if (next) setTimeout(() => findInputRef.current?.focus(), 60)
                return next
              })
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition shrink-0 ${
              showFindReplace
                ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-200'
                : 'bg-[#1c2130] hover:bg-[#252c40] border-slate-700/80 text-slate-300'
            }`}
            title="尋找與取代 (⌘F)"
          >
            <Search className="w-3.5 h-3.5 text-cyan-400" />
            <span>尋找取代 (⌘F)</span>
          </button>

          {/* Collapse Deleted Toggle */}
          <button
            onClick={() => setIsCollapsedDeleted((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition shrink-0 ${
              isCollapsedDeleted
                ? 'bg-rose-500/20 border-rose-400/50 text-rose-200'
                : 'bg-[#1c2130] hover:bg-[#252c40] border-slate-700/80 text-slate-300'
            }`}
            title="摺疊或展開所有已剪除的文字"
          >
            {isCollapsedDeleted ? (
              <EyeOff className="w-3.5 h-3.5 text-rose-400" />
            ) : (
              <Eye className="w-3.5 h-3.5 text-slate-400" />
            )}
            <span>{isCollapsedDeleted ? '展開已剪' : '摺疊已剪'}</span>
          </button>
        </div>

        {/* Right Export Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleInstantSrtDownload}
            disabled={segments.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1c2130] hover:bg-[#252c40] text-slate-200 text-xs font-medium border border-slate-700/80 transition disabled:opacity-40 shrink-0 whitespace-nowrap"
            title="立即匯出重算時間軸後的 UTF-8 .srt 字幕檔"
          >
            <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>匯出 SRT</span>
          </button>

          <button
            onClick={handleExport}
            disabled={!project || segments.length === 0 || isExporting}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-[#00d287] hover:bg-[#00bf7a] text-[#062419] font-bold text-xs shadow-md shadow-emerald-500/20 transition disabled:opacity-50 shrink-0 whitespace-nowrap"
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
                      '--spinner-color': '#062419',
                    } as React.CSSProperties
                  }
                />
                <span>匯出中...</span>
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 fill-current shrink-0" />
                <span>匯出影片</span>
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
                {showSubtitleOverlay && activePlaybackInfo.activeSeg && (() => {
                  const seg = activePlaybackInfo.activeSeg
                  if (seg.caption !== undefined && seg.caption !== null) {
                    if (!seg.caption.trim()) return null
                    return (
                      <div className="absolute bottom-6 inset-x-6 flex justify-center pointer-events-none">
                        <div className="bg-black/80 backdrop-blur-md px-4 py-2 rounded-lg border border-white/10 shadow-lg max-w-[92%] text-center">
                          <span className="text-white text-base md:text-lg font-bold tracking-wide">
                            {seg.caption}
                          </span>
                        </div>
                      </div>
                    )
                  }

                  const keptWords = seg.tokens.filter((t) => !t.deleted && t.type === 'word')
                  if (keptWords.length === 0) return null

                  return (
                    <div className="absolute bottom-6 inset-x-6 flex justify-center pointer-events-none">
                      <div className="bg-black/80 backdrop-blur-md px-4 py-2 rounded-lg border border-white/10 shadow-lg max-w-[92%] text-center">
                        <div className="flex flex-wrap items-center justify-center gap-0.5 text-base md:text-lg font-bold tracking-wide">
                          {keptWords.map((tok) => {
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
                  )
                })()}
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
          <div className="px-5 py-2.5 bg-[#121621] border-b border-[#202534] flex flex-wrap items-center justify-between gap-3 shrink-0">
            {/* Batch Silence Controls */}
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <div className="flex items-center gap-1.5 bg-[#0c0e14] px-2.5 py-1 rounded-lg border border-slate-800 text-xs shrink-0 whitespace-nowrap">
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
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-medium transition shrink-0 whitespace-nowrap"
              >
                <span>選取 &ge; {batchSilenceMin.toFixed(1)}s 氣口</span>
              </button>

              <button
                onClick={() => handleDeleteSilencesAbove(batchSilenceMin)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shadow-sm transition shrink-0 whitespace-nowrap"
              >
                <Wand2 className="w-3.5 h-3.5 shrink-0" />
                <span>一鍵剪除氣口 (&ge;{batchSilenceMin.toFixed(1)}s)</span>
              </button>

              {/* Shorten Silence Button */}
              <button
                onClick={() => setShowShortenModal(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-medium transition shrink-0 whitespace-nowrap"
                title="將超過長度的氣口縮短保留為自然換氣時間（如 0.25s）"
              >
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span>縮短氣口...</span>
              </button>

              {/* Filler Words Removal Button */}
              <button
                onClick={() => {
                  const initialChecked = new Set(detectedFillerList.map((f) => f.term))
                  setCheckedFillerWords(initialChecked)
                  setShowFillerModal(true)
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/35 text-xs font-medium transition shrink-0 whitespace-nowrap"
                title="檢測並批量剪除語助詞與口頭贅字（如：那個、就是、嗯）"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span>贅字清理 ({detectedFillerList.reduce((acc, f) => acc + f.count, 0)})</span>
              </button>

              {(stats.deletedWords > 0 || stats.deletedSilences > 0) && (
                <button
                  onClick={handleRestoreAllTokens}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition shrink-0 whitespace-nowrap"
                >
                  <RotateCcw className="w-3 h-3 shrink-0" />
                  <span>全部還原</span>
                </button>
              )}
            </div>

            {/* Selection Contextual Actions */}
            <div className="flex items-center gap-2 shrink-0">
              {selectedTokenIds.size > 0 ? (
                <>
                  <span className="text-xs text-emerald-400 font-medium shrink-0 whitespace-nowrap">
                    已選取 {selectedTokenIds.size} 個積木
                  </span>
                  {(() => {
                    const allSelectedDeleted = Array.from(selectedTokenIds).every((id) => {
                      for (const s of segments) {
                        for (const t of s.tokens) {
                          if (t.id === id) return t.deleted
                        }
                      }
                      return false
                    })
                    const hasSelectedWord = Array.from(selectedTokenIds).some((id) => {
                      for (const s of segments) {
                        for (const t of s.tokens) {
                          if (t.id === id) return t.type === 'word'
                        }
                      }
                      return false
                    })
                    const hasSelectedSilence = Array.from(selectedTokenIds).some((id) => {
                      for (const s of segments) {
                        for (const t of s.tokens) {
                          if (t.id === id && t.type === 'silence') {
                            return true
                          }
                        }
                      }
                      return false
                    })
                    const hasSelectedShortenedSilence = Array.from(selectedTokenIds).some((id) => {
                      for (const s of segments) {
                        for (const t of s.tokens) {
                          if (t.id === id && t.type === 'silence' && t.keep_duration != null) {
                            return true
                          }
                        }
                      }
                      return false
                    })
                    return (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={toggleSelectedDeleted}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition shrink-0 whitespace-nowrap ${
                            allSelectedDeleted
                              ? 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border-emerald-500/40'
                              : 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border-rose-500/40'
                          }`}
                          title={allSelectedDeleted ? '按 R 或點擊此處還原' : '按 Backspace 或點擊此處剪除'}
                        >
                          {allSelectedDeleted ? (
                            <>
                              <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                              <span>還原所選 (R)</span>
                            </>
                          ) : (
                            <>
                              <Trash2 className="w-3.5 h-3.5 shrink-0" />
                              <span>剪除所選 (Backspace)</span>
                            </>
                          )}
                        </button>

                        {/* Multi-token Phrase Edit Button */}
                        {hasSelectedWord && (
                          <button
                            onClick={handleOpenPhraseModal}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-medium transition shrink-0 whitespace-nowrap"
                            title="修改選取的文字詞彙 (E)"
                          >
                            <Edit3 className="w-3 h-3 shrink-0" />
                            <span>改詞 (E)</span>
                          </button>
                        )}

                        {/* Restore shortened silence back to full duration */}
                        {hasSelectedShortenedSilence && (
                          <button
                            onClick={handleRestoreSelectedTokens}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-medium transition shrink-0 whitespace-nowrap shadow-sm"
                            title="將選取的縮短氣口恢復為完整原始長度 (快捷鍵 R)"
                          >
                            <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                            <span>恢復原長度 (R)</span>
                          </button>
                        )}

                        {/* Quick shorten silence button for selected silence */}
                        {hasSelectedSilence && (
                          <button
                            onClick={() => handleShortenSelectedSilence(0.25)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-medium transition shrink-0 whitespace-nowrap"
                            title="將選取的氣口縮短保留為 0.25s"
                          >
                            <Clock className="w-3 h-3 shrink-0" />
                            <span>縮短為 0.25s</span>
                          </button>
                        )}
                      </div>
                    )
                  })()}
                  {selectedTokenIds.size === 1 && (
                    <button
                      onClick={() => handleSplitSegmentAtToken()}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs transition shrink-0 whitespace-nowrap"
                    >
                      <CornerDownLeft className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>拆行 (Enter)</span>
                    </button>
                  )}
                </>
              ) : (
                <span className="text-xs text-slate-400 shrink-0 whitespace-nowrap hidden sm:inline">
                  💡 提示：按 <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-200 border border-slate-700">Backspace</kbd> 剪除；<kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-200 border border-slate-700">E</kbd> 改詞；<kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-200 border border-slate-700">⌘F</kbd> 搜尋；<kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-200 border border-slate-700">R</kbd> 還原；<kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-200 border border-slate-700">⌘Z</kbd> 復原
                </span>
              )}
            </div>
          </div>

          {/* FLOATING FIND & REPLACE BAR (⌘F) */}
          {showFindReplace && (
            <div className="bg-[#151928] border-b border-cyan-500/40 px-5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs z-10 shrink-0 shadow-lg">
              <div className="flex items-center gap-2 flex-1 max-w-3xl flex-wrap">
                {/* Find Input */}
                <div className="flex items-center bg-[#0c0e14] border border-slate-700 focus-within:border-cyan-400 rounded-lg px-2.5 py-1 min-w-[200px] flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-400 mr-2 shrink-0" />
                  <input
                    ref={findInputRef}
                    type="text"
                    value={findQuery}
                    onChange={(e) => {
                      setFindQuery(e.target.value)
                      setFindMatchIdx(0)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        if (e.shiftKey) handleFindPrev()
                        else handleFindNext()
                      }
                    }}
                    placeholder="尋找文字 (Enter 下一個，Shift+Enter 上一個)..."
                    className="w-full bg-transparent text-white focus:outline-none text-xs"
                  />
                  {searchMatches.length > 0 ? (
                    <span className="text-[11px] font-mono text-cyan-400 shrink-0 ml-1.5 whitespace-nowrap">
                      {findMatchIdx + 1}/{searchMatches.length}
                    </span>
                  ) : findQuery.trim() ? (
                    <span className="text-[11px] text-slate-500 shrink-0 ml-1.5 whitespace-nowrap">
                      無符合
                    </span>
                  ) : null}
                </div>

                {/* Replace Input */}
                <div className="flex items-center bg-[#0c0e14] border border-slate-700 focus-within:border-cyan-400 rounded-lg px-2.5 py-1 min-w-[180px] flex-1">
                  <Edit3 className="w-3.5 h-3.5 text-slate-400 mr-2 shrink-0" />
                  <input
                    type="text"
                    value={replaceQuery}
                    onChange={(e) => setReplaceQuery(e.target.value)}
                    placeholder="取代為..."
                    className="w-full bg-transparent text-white focus:outline-none text-xs"
                  />
                </div>

                {/* Navigation & Replace Buttons */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={handleFindPrev}
                    disabled={searchMatches.length === 0}
                    className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-30 transition"
                    title="上一個 (Shift+Enter)"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={handleFindNext}
                    disabled={searchMatches.length === 0}
                    className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-30 transition"
                    title="下一個 (Enter)"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={handleSelectAllMatches}
                    disabled={searchMatches.length === 0}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] disabled:opacity-30 transition whitespace-nowrap"
                    title="全選所有符合的字詞，可直接按 Backspace 批量剪除"
                  >
                    全選符合項
                  </button>
                  <button
                    onClick={handleReplaceCurrentMatch}
                    disabled={searchMatches.length === 0}
                    className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-[11px] disabled:opacity-30 transition whitespace-nowrap"
                  >
                    取代
                  </button>
                  <button
                    onClick={handleReplaceAllMatches}
                    disabled={searchMatches.length === 0}
                    className="px-2.5 py-1 rounded bg-indigo-500 hover:bg-indigo-400 text-white font-bold text-[11px] disabled:opacity-30 transition whitespace-nowrap shadow-sm shadow-indigo-500/20"
                  >
                    全部取代
                  </button>
                </div>
              </div>

              <button
                onClick={() => setShowFindReplace(false)}
                className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
                title="關閉尋找列 (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* TRANSCRIPT ROWS SCROLLER */}
          <div className="flex-1 overflow-y-auto transcript-scroller p-5 space-y-3">
            {segments.map((seg, segIdx) => {
              const rowStart = seg.tokens[0]?.start ?? 0
              const rowEnd = seg.tokens[seg.tokens.length - 1]?.end ?? 0
              const isRowActive = activePlaybackInfo.activeSeg?.id === seg.id
              const defaultCaption = joinSegmentWords(seg.tokens, false)
              const isCustomCaption = seg.caption !== undefined && seg.caption !== null
              const allRowDeleted =
                seg.tokens.length > 0 && seg.tokens.every((t) => t.deleted)

              return (
                <div
                  key={seg.id}
                  id={`seg-${seg.id}`}
                  className={`group rounded-2xl border transition-all duration-150 p-3.5 space-y-3 ${
                    isRowActive
                      ? 'bg-[#161c2e] border-cyan-500/50 shadow-lg shadow-cyan-950/20'
                      : allRowDeleted
                      ? 'bg-[#10121a]/60 border-slate-800/50 opacity-60'
                      : 'bg-[#131722] border-slate-800/80 hover:border-slate-700'
                  }`}
                >
                  {/* Segment Row Header */}
                  <div className="flex items-center justify-between">
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
                    </div>

                    {/* Row Quick Actions */}
                    <div className="flex items-center gap-1.5 opacity-70 group-hover:opacity-100 transition">
                      {segIdx > 0 && (
                        <button
                          onClick={() => handleMergeWithPreviousSegment(segIdx)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-[11px] transition"
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
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-rose-500/20 text-slate-300 hover:text-rose-300 text-[11px] transition"
                      >
                        <Scissors className="w-3 h-3" />
                        <span>{allRowDeleted ? '還原整列' : '剪除整列'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Track 1: 🎬 Video Cuts (音畫時間軸積木軌) */}
                  <div className="flex items-start gap-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 shrink-0 w-[82px] pt-1.5 select-none">
                      <Film className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span>Video Cuts</span>
                    </div>

                    <div className="flex-1 flex flex-wrap items-center gap-1.5 min-w-0">
                      {(() => {
                        type RenderItem =
                          | { type: 'single'; tok: Token }
                          | { type: 'collapsed'; tokens: Token[] }

                        const items: RenderItem[] = []
                        if (!isCollapsedDeleted) {
                          for (const tok of seg.tokens) {
                            items.push({ type: 'single', tok })
                          }
                        } else {
                          let delRun: Token[] = []
                          for (const tok of seg.tokens) {
                            if (tok.deleted) {
                              delRun.push(tok)
                            } else {
                              if (delRun.length > 0) {
                                items.push({ type: 'collapsed', tokens: delRun })
                                delRun = []
                              }
                              items.push({ type: 'single', tok })
                            }
                          }
                          if (delRun.length > 0) {
                            items.push({ type: 'collapsed', tokens: delRun })
                          }
                        }

                        return items.map((item, itemIdx) => {
                          if (item.type === 'collapsed') {
                            const count = item.tokens.length
                            const delText = item.tokens.map((t) => t.text).join('')
                            return (
                              <div
                                key={`collapsed-${item.tokens[0].id}-${itemIdx}`}
                                onClick={() => {
                                  const ids = new Set(item.tokens.map((t) => t.id))
                                  setSelectedTokenIds(ids)
                                  setCursorTokenId(item.tokens[0].id)
                                  setStatusMessage(`已選取已剪除的 ${count} 個字元/氣口（按 R 可還原）`)
                                }}
                                title={`已剪除內容：「${delText}」· 點擊選取，按 R 還原`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-950/30 hover:bg-rose-950/60 border border-rose-500/30 text-rose-300 text-xs font-mono cursor-pointer transition select-none shadow-sm"
                              >
                                <Scissors className="w-3 h-3 text-rose-400 shrink-0" />
                                <span>已剪 {count} 項</span>
                              </div>
                            )
                          }

                          const tok = item.tok
                          const flatIdx = flatTokens.findIndex(
                            (it) => it.token.id === tok.id
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

                          const isCaretHere = flatIdx === cursorFlatIndex
                          const isShortened =
                            tok.type === 'silence' &&
                            !tok.deleted &&
                            tok.keep_duration != null &&
                            tok.keep_duration > 0 &&
                            tok.keep_duration < tok.end - tok.start

                          if (tok.type === 'silence') {
                            return (
                              <div
                                key={tok.id}
                                id={`tok-${tok.id}`}
                                onMouseDown={(e) => handleTokenMouseDown(e, tok, flatIdx)}
                                onMouseEnter={() => handleTokenMouseEnter(flatIdx)}
                                title={
                                  isShortened
                                    ? `已縮短氣口：原 ${(tok.end - tok.start).toFixed(2)}s ➔ 保留 ${tok.keep_duration!.toFixed(2)}s (點選按 R 恢復原長度)`
                                    : `氣口區間：${tok.start.toFixed(2)}s - ${tok.end.toFixed(2)}s (點擊右上角或按空白鍵剪除)`
                                }
                                className={`group/tok cursor-pointer px-2.5 py-1.5 rounded-lg text-xs font-mono font-medium border transition-all flex items-center gap-1 relative ${
                                  tok.deleted
                                    ? 'line-through opacity-35 bg-rose-950/25 border-rose-500/30 text-rose-300'
                                    : isSelected
                                    ? 'bg-amber-400/25 border-amber-400 border-dashed text-amber-200 ring-2 ring-amber-400/30'
                                    : isPlayingNow
                                    ? 'bg-amber-500/30 border-amber-300 text-amber-100 scale-105'
                                    : isShortened
                                    ? 'bg-cyan-950/40 border-cyan-400/60 text-cyan-200 shadow-sm'
                                    : 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30 text-amber-300'
                                }`}
                              >
                                {isShortened && <Clock className="w-3 h-3 text-cyan-400 shrink-0" />}
                                <span>{tok.text}</span>
                                {isCaretHere && (
                                  <span
                                    className={`word-caret ${
                                      isAtRowStart ? 'caret-left' : 'caret-right'
                                    }`}
                                  />
                                )}

                                {/* Corner Hover Quick Cut / Restore Button */}
                                <button
                                  type="button"
                                  onMouseDown={(e) => {
                                    e.stopPropagation()
                                    handleToggleSingleTokenDeleted(tok.id)
                                  }}
                                  title={tok.deleted ? '點擊還原氣口 (R)' : '點擊剪除氣口'}
                                  className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center transition-all z-10 shadow-sm ${
                                    tok.deleted
                                      ? 'bg-rose-500 hover:bg-rose-400 text-white opacity-90 hover:scale-110'
                                      : isSelected
                                      ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 opacity-100 hover:scale-110 border border-amber-300'
                                      : 'bg-[#1e2436] hover:bg-rose-500 text-slate-400 hover:text-white border border-slate-600 opacity-0 group-hover/tok:opacity-100 hover:scale-110'
                                  }`}
                                >
                                  {tok.deleted ? (
                                    <RotateCcw className="w-2.5 h-2.5 stroke-[2.5]" />
                                  ) : (
                                    <X className="w-2.5 h-2.5 stroke-[2.5]" />
                                  )}
                                </button>
                              </div>
                            )
                          }

                          // Word / Character Token Block
                          return (
                            <div
                              key={tok.id}
                              id={`tok-${tok.id}`}
                              onMouseDown={(e) => handleTokenMouseDown(e, tok, flatIdx)}
                              onMouseEnter={() => handleTokenMouseEnter(flatIdx)}
                              onDoubleClick={() => startEditingToken(tok)}
                              title={`${tok.text} (${tok.start.toFixed(2)}s - ${tok.end.toFixed(2)}s) · 雙擊改字，按 E 改詞`}
                              className={`group/tok cursor-pointer min-w-[34px] px-2.5 py-1.5 rounded-lg text-sm font-semibold border transition-all text-center relative ${
                                tok.deleted
                                  ? 'line-through opacity-35 bg-rose-950/25 border-rose-500/30 text-rose-300'
                                  : isSelected
                                  ? 'bg-cyan-500/25 border-cyan-400 border-dashed text-white ring-2 ring-cyan-400/30 shadow-sm'
                                  : isPlayingNow
                                  ? 'bg-cyan-400 text-slate-950 border-cyan-300 shadow-md shadow-cyan-500/25 scale-105'
                                  : 'bg-[#1b2132] hover:bg-[#232b42] border-slate-700/80 text-slate-100'
                              }`}
                            >
                              <span>{tok.text}</span>
                              {isCaretHere && (
                                <span
                                  className={`word-caret ${
                                    isAtRowStart ? 'caret-left' : 'caret-right'
                                  }`}
                                />
                              )}

                              {/* Corner Hover Quick Cut / Restore Button */}
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.stopPropagation()
                                  handleToggleSingleTokenDeleted(tok.id)
                                }}
                                title={tok.deleted ? '點擊還原此字 (R)' : '點擊剪除此字'}
                                className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center transition-all z-10 shadow-sm ${
                                  tok.deleted
                                    ? 'bg-rose-500 hover:bg-rose-400 text-white opacity-90 hover:scale-110'
                                    : isSelected
                                    ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 opacity-100 hover:scale-110 border border-cyan-300'
                                    : 'bg-[#1e2436] hover:bg-rose-500 text-slate-400 hover:text-white border border-slate-600 opacity-0 group-hover/tok:opacity-100 hover:scale-110'
                                }`}
                              >
                                {tok.deleted ? (
                                  <RotateCcw className="w-2.5 h-2.5 stroke-[2.5]" />
                                ) : (
                                  <X className="w-2.5 h-2.5 stroke-[2.5]" />
                                )}
                              </button>
                            </div>
                          )
                        })
                      })()}
                    </div>
                  </div>

                  {/* Track 2: 💬 Subtitle Caption Box (獨立字幕編輯軌) */}
                  <div className="flex items-center gap-2.5 pt-2 border-t border-slate-800/60">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 shrink-0 w-[82px] select-none">
                      <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>螢幕字幕</span>
                    </div>

                    <div className="flex-1 flex items-center bg-[#0a0c12] hover:bg-[#0d1017] focus-within:bg-[#0d1017] border border-slate-800 focus-within:border-emerald-500/60 rounded-xl px-3 py-1.5 transition-all shadow-inner">
                      <input
                        type="text"
                        value={isCustomCaption ? seg.caption! : defaultCaption}
                        onChange={(e) => handleUpdateSegmentCaption(seg.id, e.target.value)}
                        onFocus={() => {
                          if (videoRef.current && rowStart !== null) {
                            videoRef.current.currentTime = rowStart
                            setCurrentTime(rowStart)
                          }
                        }}
                        placeholder={
                          allRowDeleted
                            ? '(整列已剪除，將不輸出至字幕)'
                            : '輸入自訂字幕文字 (直接編輯，不破壞影片時間軸)...'
                        }
                        disabled={allRowDeleted}
                        className={`w-full bg-transparent text-xs font-sans tracking-wide focus:outline-none transition ${
                          allRowDeleted
                            ? 'line-through text-slate-600 italic'
                            : isCustomCaption
                            ? 'text-emerald-300 font-medium'
                            : 'text-slate-200'
                        }`}
                      />

                      {/* Right Control Badges: [A / ✎ 自訂] & [🔄] */}
                      <div className="flex items-center gap-1.5 shrink-0 ml-2 select-none">
                        {isCustomCaption ? (
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1"
                            title="已自訂字幕，螢幕 CC 與 SRT 匯出均以文字框內容為準"
                          >
                            <span>✎ 自訂</span>
                          </span>
                        ) : (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800/90 text-slate-400 border border-slate-700/60 font-mono"
                            title="自動同步中：即時連動 Video Cuts 未刪除之辨識字塊"
                          >
                            A
                          </span>
                        )}

                        {isCustomCaption && (
                          <button
                            onClick={() => handleResetSegmentCaption(seg.id)}
                            className="p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-300 transition"
                            title="重新同步回 Video Cuts 保留字塊"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
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

      {/* PHASE 1: SHORTEN SILENCES MODAL */}
      {showShortenModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="bg-[#151925] border border-cyan-500/30 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">氣口縮短 (保留自然換氣停頓)</h3>
                  <p className="text-[11px] text-slate-400">
                    將過長的氣口縮短保留為自然呼吸長度，避免直接一刀切斷造成喘不過氣
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowShortenModal(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Quick Presets */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">推薦預設模式</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShortenMinSec(0.5)
                    setShortenTargetSec(0.25)
                  }}
                  className={`p-2.5 rounded-xl border text-left transition ${
                    shortenMinSec === 0.5 && shortenTargetSec === 0.25
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-[#0c0e14] border-slate-800 hover:border-slate-700 text-slate-300'
                  }`}
                >
                  <div className="text-xs font-bold">自然呼吸 (推薦)</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">&ge;0.5s 縮為 0.25s</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShortenMinSec(0.4)
                    setShortenTargetSec(0.15)
                  }}
                  className={`p-2.5 rounded-xl border text-left transition ${
                    shortenMinSec === 0.4 && shortenTargetSec === 0.15
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-[#0c0e14] border-slate-800 hover:border-slate-700 text-slate-300'
                  }`}
                >
                  <div className="text-xs font-bold">緊湊節奏</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">&ge;0.4s 縮為 0.15s</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShortenMinSec(0.6)
                    setShortenTargetSec(0.3)
                  }}
                  className={`p-2.5 rounded-xl border text-left transition ${
                    shortenMinSec === 0.6 && shortenTargetSec === 0.3
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-[#0c0e14] border-slate-800 hover:border-slate-700 text-slate-300'
                  }`}
                >
                  <div className="text-xs font-bold">舒緩語速</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">&ge;0.6s 縮為 0.30s</div>
                </button>
              </div>
            </div>

            {/* Parameter Inputs */}
            <div className="grid grid-cols-2 gap-3 bg-[#0c0e14] p-3.5 rounded-xl border border-slate-800">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">氣口長度門檻 (&ge; 秒)</label>
                <input
                  type="number"
                  step={0.05}
                  min={0.1}
                  max={5.0}
                  value={shortenMinSec}
                  onChange={(e) => setShortenMinSec(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
                  className="w-full bg-[#151925] border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm font-mono text-cyan-300 focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">縮短後保留長度 (秒)</label>
                <input
                  type="number"
                  step={0.05}
                  min={0.05}
                  max={shortenMinSec}
                  value={shortenTargetSec}
                  onChange={(e) => setShortenTargetSec(Math.max(0.05, parseFloat(e.target.value) || 0.05))}
                  className="w-full bg-[#151925] border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm font-mono text-cyan-300 focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>

            {/* Impact Calculation Preview */}
            {(() => {
              let matchCount = 0
              let estSaved = 0
              segments.forEach((seg) => {
                seg.tokens.forEach((tok) => {
                  if (tok.type === 'silence') {
                    const gap = tok.end - tok.start
                    if (gap >= shortenMinSec - 1e-4 && shortenTargetSec < gap) {
                      matchCount++
                      estSaved += gap - shortenTargetSec
                    }
                  }
                })
              })
              return (
                <div className="p-3 rounded-xl bg-cyan-950/30 border border-cyan-500/30 text-xs flex items-center justify-between">
                  <span className="text-slate-300">
                    預計將處理 <strong className="text-cyan-300 font-mono text-sm">{matchCount}</strong> 處氣口
                  </span>
                  <span className="text-emerald-400 font-mono font-semibold">
                    預估節省 ~{estSaved.toFixed(1)}s
                  </span>
                </div>
              )
            })()}

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowShortenModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleBatchShortenSilences(shortenMinSec, shortenTargetSec)}
                className="px-5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs shadow-md shadow-cyan-500/20 transition flex items-center gap-1.5"
              >
                <Clock className="w-3.5 h-3.5" />
                <span>套用氣口縮短</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PHASE 1: FILLER WORDS REMOVAL MODAL */}
      {showFillerModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="bg-[#151925] border border-indigo-500/30 rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">贅字與口頭禪清理</h3>
                  <p className="text-[11px] text-slate-400">
                    自動辨識並標記文稿中的贅字助詞，可一鍵選取或直接批量剪除
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowFillerModal(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Custom Filler Words Input */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-300 font-medium">新增自訂贅字詞彙</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={customFillerInput}
                  onChange={(e) => setCustomFillerInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const val = customFillerInput.trim()
                      if (val && !customFillerTerms.includes(val)) {
                        setCustomFillerTerms((prev) => [...prev, val])
                        setCheckedFillerWords((prev) => new Set([...prev, val]))
                        setCustomFillerInput('')
                      }
                    }
                  }}
                  placeholder="輸入口頭禪 (如：基本上、你知道、坦白說)，按 Enter 新增..."
                  className="flex-1 bg-[#0c0e14] border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-400"
                />
                <button
                  type="button"
                  onClick={() => {
                    const val = customFillerInput.trim()
                    if (val && !customFillerTerms.includes(val)) {
                      setCustomFillerTerms((prev) => [...prev, val])
                      setCheckedFillerWords((prev) => new Set([...prev, val]))
                      setCustomFillerInput('')
                    }
                  }}
                  className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition"
                >
                  新增
                </button>
              </div>
              {customFillerTerms.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {customFillerTerms.map((term) => (
                    <span
                      key={term}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs"
                    >
                      <span>{term}</span>
                      <button
                        onClick={() => {
                          setCustomFillerTerms((prev) => prev.filter((t) => t !== term))
                          setCheckedFillerWords((prev) => {
                            const next = new Set(prev)
                            next.delete(term)
                            return next
                          })
                        }}
                        className="hover:text-rose-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Detected Filler Checklist */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  文稿中已偵測到 ({detectedFillerList.reduce((acc, f) => acc + f.count, 0)} 處)：
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCheckedFillerWords(new Set(detectedFillerList.map((f) => f.term)))
                    }}
                    className="text-[11px] text-indigo-400 hover:underline"
                  >
                    全選
                  </button>
                  <span className="text-slate-600">|</span>
                  <button
                    type="button"
                    onClick={() => setCheckedFillerWords(new Set())}
                    className="text-[11px] text-slate-400 hover:underline"
                  >
                    清除勾選
                  </button>
                </div>
              </div>

              <div className="max-h-48 overflow-y-auto transcript-scroller bg-[#0c0e14] p-2.5 rounded-xl border border-slate-800 space-y-1">
                {detectedFillerList.length === 0 ? (
                  <div className="text-xs text-slate-500 py-4 text-center">
                    目前文稿中未偵測到明顯贅字或口頭助詞
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    {detectedFillerList.map((item) => {
                      const isChecked = checkedFillerWords.has(item.term)
                      return (
                        <label
                          key={item.term}
                          className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer transition select-none ${
                            isChecked
                              ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-200'
                              : 'bg-[#151925]/60 border-slate-800 hover:border-slate-700 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                setCheckedFillerWords((prev) => {
                                  const next = new Set(prev)
                                  if (e.target.checked) next.add(item.term)
                                  else next.delete(item.term)
                                  return next
                                })
                              }}
                              className="rounded border-slate-700 text-indigo-600 focus:ring-0"
                            />
                            <span className="font-semibold text-white">「{item.term}」</span>
                          </div>
                          <span className="font-mono text-[11px] text-indigo-400">
                            {item.count} 次
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowFillerModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
              >
                取消
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSelectFillerWords}
                  className="px-3.5 py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-500/40 text-xs font-semibold transition"
                >
                  僅標記選取
                </button>
                <button
                  type="button"
                  onClick={handleDeleteFillerWords}
                  className="px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-bold text-xs shadow-md shadow-rose-500/20 transition flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>一鍵剪除所選贅字</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PHASE 2: MULTI-TOKEN PHRASE EDIT MODAL */}
      {showPhraseModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="bg-[#151925] border border-cyan-500/30 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
                  <Edit3 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">多字連選改詞</h3>
                  <p className="text-[11px] text-slate-400">
                    重新輸入詞彙，系統將自動依字數均分重算字級時間軸
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowPhraseModal(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Current Selection Info */}
            {(() => {
              const selItems = flatTokens.filter((item) => selectedTokenIds.has(item.token.id))
              const origText = selItems.map((it) => it.token.text).join('')
              const startT = selItems[0]?.token.start ?? 0
              const endT = selItems[selItems.length - 1]?.token.end ?? 0
              return (
                <div className="bg-[#0c0e14] p-3 rounded-xl border border-slate-800 text-xs space-y-1">
                  <div className="flex items-center justify-between text-slate-400">
                    <span>原文字段：</span>
                    <span className="font-mono text-cyan-400">
                      {startT.toFixed(2)}s ~ {endT.toFixed(2)}s (共 {(endT - startT).toFixed(2)}s)
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-white bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800">
                    {origText || '(未選取)'}
                  </div>
                </div>
              )
            })()}

            {/* Input */}
            <div>
              <label className="text-xs text-slate-300 font-medium block mb-1.5">
                輸入新詞彙
              </label>
              <input
                type="text"
                autoFocus
                value={phraseInput}
                onChange={(e) => setPhraseInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleCommitPhraseEdit(phraseInput)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setShowPhraseModal(false)
                  }
                }}
                placeholder="輸入修正後的新詞..."
                className="w-full bg-[#0c0e14] border border-slate-700 focus:border-cyan-400 rounded-xl px-3 py-2 text-sm text-white focus:outline-none"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowPhraseModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleCommitPhraseEdit(phraseInput)}
                className="px-5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs shadow-md shadow-cyan-500/20 transition flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5 stroke-[3]" />
                <span>確認修改 (Enter)</span>
              </button>
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
                <span className="text-slate-300">關鍵字搜尋與批量取代</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  ⌘F / Ctrl+F
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">多字連選直接改詞</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  E
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">文字游標連續往左剪除 (Word 模式)</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  Backspace
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">在列首與上一列字幕合併</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  列首 Backspace
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">向後剪除字元 (Forward Delete)</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  Delete
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">移動文字游標 (加 Shift 擴選)</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  ← → ↑ ↓
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">播放 / 暫停 (若多選則批量剪除)</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  Space
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">還原游標處或選取的字/氣口</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  R
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">游標處斷行拆分為兩列</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  Enter
                </kbd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-300">修正同音錯字（不剪掉畫面）</span>
                <kbd className="px-2 py-0.5 bg-slate-800 rounded border border-slate-700 font-mono text-cyan-300">
                  雙擊單字
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
