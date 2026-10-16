# Werv Studio — Mac 本機端逐字稿剪輯工具 (Apple Silicon Edition)

複刻 **Vrew** 最核心的兩項體驗，專為 **Apple Silicon (M 系列晶片)** 打造的零雲端成本、高精準度台灣繁體中文「刪字即剪片」工具：

1. **高精準度的台灣繁體中文語音辨識與字級對齊 (模組 A)**
   - 使用 `mlx-whisper` 原生載入 `mlx-community/whisper-large-v3-turbo` 或 `whisper-large-v3`
   - 強制鎖定 `language="zh"`、`word_timestamps=True`、`condition_on_previous_text=False`（防止長靜音與背景音樂幻覺漂移）
   - 支援自訂專有名詞 `initial_prompt`，並結合 `OpenCC (s2twp)` 強制轉為台灣繁體中文與台灣慣用詞彙
   - 結合 `silero-vad` 語音起訖點校準每句首尾字元時間邊界，避免字尾時間拉長吃進靜音段
   - 自動偵測相鄰字元間隔 `>= 門檻 (預設 0.4s，UI 即時可調)` 生成 `[··· 0.6s]` 氣口積木

2. **「句子列 + 字元積木」雙模式編輯器 (模組 B)**
   - **剪輯刪除模式 (Cut Mode)**：點選或拖曳選取任意單字、詞組或氣口，按 `Space` 或 `Delete` 切換刪除線與半透明標記 (`deleted = true`)
   - **改錯字模式 (Edit Text Mode)**：雙擊任意單字（或切換為改錯字模式點擊），直接修改文字而不改變 `start/end` 與剪輯狀態
   - **氣口批次操作**：支援「一鍵選取 / 一鍵刪除所有 >= X 秒的氣口」與完整 `Undo / Redo` (`⌘Z` / `⌘⇧Z`) 歷史堆疊
   - **分行與合併**：在任一字按 `Enter` 將該列拆分為兩列字幕；在列首按 `Backspace`（或點擊合併按鈕）與上一列合併

3. **零延遲虛擬時間軸預覽 (模組 C)**
   - 編輯過程絕不呼叫 FFmpeg 重新壓片
   - 自動將 `deleted = false` 的 Token 加上前後 `0.05s` Padding 並合併相距 `<= 0.08s` 的區間 (`keep_ranges`)
   - 使用 `requestAnimationFrame` 高頻監聽 `video.currentTime`，播放頭進入刪除區間時瞬間跳轉至下一段 `keep_range.start`

4. **Apple VideoToolbox 硬體加速匯出 + 重算時間軸 SRT (模組 D)**
   - 嚴禁使用 `-c copy`，透過 FFmpeg `trim` / `atrim` 與 `15ms afade` 消除切點電流爆音 (Audio Pop)
   - 強制使用 Mac 硬體編碼 `-c:v h264_videotoolbox -b:v 15M -pix_fmt yuv420p -c:a aac -b:a 192k`
   - 當保留片段超過 50 段時自動寫入暫存腳本檔呼叫，避免命令列過長
   - 精準重算 (Remap) 每一列未刪除文字在新影片中的累積時間戳，一鍵打包下載 `.mp4` + UTF-8 `.srt` (`.zip`) 供匯入剪映 (CapCut) 後製

---

## 快速啟動

```bash
cd /Users/yuanyuanwang/workspace/werv
./start.sh
```

啟動後打開瀏覽器前往：**http://localhost:5173**
