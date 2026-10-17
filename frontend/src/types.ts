export type TokenType = 'word' | 'silence'

export interface Token {
  id: string
  type: TokenType
  text: string
  start: number
  end: number
  deleted: boolean
  keep_duration?: number | null
}

export interface Segment {
  id: string
  tokens: Token[]
}

export interface KeepRange {
  start: number
  end: number
}

export type WhisperModelName =
  | 'mlx-community/whisper-large-v3-turbo'
  | 'mlx-community/whisper-large-v3'

export interface ProjectMetadata {
  project_id: string
  filename: string
  video_url: string
  duration: number
  width: number
  height: number
  fps: number
  model_name: WhisperModelName
  custom_prompt: string
  silence_threshold: number
  segments: Segment[]
  vad_intervals?: Array<{ start: number; end: number }>
}

export interface ExportResponse {
  export_id: string
  mp4_url: string
  srt_url: string
  bundle_url: string
  srt_content: string
  keep_ranges: KeepRange[]
  original_duration: number
  exported_duration: number
  saved_seconds: number
  cut_count: number
}

export type EditorMode = 'cut' | 'edit'
