# Lumina Drift（流光）v1.4.0 → v1.5.0 完整更新總結

> **比較基準**：`v1.4.0`（`247c7e9`，2026-11-26）→ `v1.5.0`（2026-11-28，完整整合 [v1.5.0 專業繪圖演進分階段實作藍圖](./ROADMAP-v1.5.0.md) Phase 1 ～ Phase 6 與最終實機複測打磨）
> **明確排除項目**：本版本依專案方向**刻意不包含**「3D 基礎幾何／3D 人偶參考」功能。

---

## 一、版本演進總覽

`v1.5.0` 圍繞**專業插畫漫畫工作流深化、進階筆刷與非破壞性效果、多人繪茶 2.0 協作體驗、動畫音訊混音輸出、商業印刷真 CMYK 分色、4K～13K 超大畫布記憶體穩定度與實機操作流暢度**推進，全部 6 個 Phase 與實機複測修復皆已完成並通過前後端與隔離式 Electron 桌面端回歸驗證。

| 藍圖階段 | 更新主題 | 核心亮點 |
| :--- | :--- | :--- |
| **Phase 1** | 圖層色標、草稿染色與用紙系統 | 8 色面板標籤、非破壞性圖層顯示色彩（主副色草稿染色）、「用紙」底色即時切換與多人廣播 |
| **Phase 2** | 尺規系統 v2 | 集中線／放射狀尺規、曲線／貝茲特殊尺規、圖層綁定尺規、純 2D 1/2/3 點透視空間網格 |
| **Phase 2.5** | 可伸縮懸浮圖標小球／膠囊 Dock | 單視窗縮球、多視窗自動拉長膠囊、橫／直向切換、點擊展開切換、拖出拆球與磁吸合併 |
| **Phase 3** | 筆刷引擎 v3 | 雙筆刷、色彩動態、濕邊／減色顏料混色、多筆尖輪播、`.sut`／`.brushset` 深度還原與 `.abr` v6.2 匯出 |
| **Phase 4** | 非破壞性圖層樣式、快速遮色片與色域選取 | 邊界／水彩邊界／陰影／外發光／色彩覆蓋、`Q` 鍵快速遮色片、色域選取對話框、WebP 匯出 |
| **Phase 5** | 多人繪茶 2.0 | 跟隨繪師視角（含旋轉／鏡像／DPI）、分格認領／接龍格線、房間共用色票盤與參考圖板 |
| **Phase 6** | 專業製作與效能收尾 | 動畫時間軸音訊波形＋MP4/WebM 音軌混音匯出、真 CMYK 4 通道 TIFF/PSD＋GCR/UCR＋TAC 警告、4K–13K Tile GPU LRU 池化與 OOM 防護 |
| **實機打磨** | 導覽器、工具集重構與主題效能升級 | 即時畫布導覽器、字型庫升級、14 類折疊工具列、單一油漆桶／整合智能填色／獨立 5 款橡皮擦工具集、自訂滾輪旋轉、單機圖層精簡、流光霓虹雙流波動與六大材質、安裝精靈 GroupBox 亮字 |

---

## 二、Phase 1 ～ Phase 6 與實機打磨詳解

### 1. 圖層面板標籤色、草稿染色與「用紙」底色系統（Phase 1）
- **圖層／資料夾面板色標**：支援 8 種高辨識度面板標籤色，於單機離線與多人房間同步持久化。
- **非破壞性圖層顯示色彩（Draft Tint）**：一鍵將線稿或草稿圖層即時著色為指定主／副色而不修改原始像素，支援 GPU 即時著色濾鏡與匯出一致性。
- **用紙（Paper）底色系統**：提供紙張底色切換與透明格紋顯示，並於多人房間即時同步畫布底色。

### 2. 尺規系統 v2（Phase 2，不含 3D 幾何／人偶）
- **集中線／放射狀與曲線／貝茲尺規**：於 `ruler-math.ts` 與 `RulerOverlay.tsx` 實作放射狀吸附、貝茲曲線切線吸附與多段控制點編輯。
- **圖層綁定尺規**：支援三種作用範圍（顯示於全部圖層／僅在同資料夾／僅在目標圖層）。
- **純 2D 透視空間網格**：支援 1/2/3 點透視與 `xy`、`xz`、`yz` 三平面獨立開關、可拖曳基準點與畫布裁剪。

### 3. 可伸縮懸浮圖標小球／膠囊 Dock（Phase 2.5）
- 支援任一浮動工具視窗縮為高辨識度圖標小球，多個小球磁吸合併為膠囊 Dock（支援橫／直向切換、點擊展開切換與拖出拆球），大幅釋放繪圖視區空間。

### 4. 筆刷引擎 v3（Phase 3）
- **核心渲染能力**：實作雙筆刷紋理疊加、色相／飽和度／明度／前後景色彩動態抖動、水彩濕邊（Wet Edge）、Kubelka-Munk 減色顏料混色，以及多筆尖隨機／循環輪播。
- **生態筆刷還原**：強化 Clip Studio Paint `.sut` 與 Procreate `.brushset` 解析還原度，自動對應筆尖、間距、動態曲線與雙筆刷參數。

### 5. 非破壞性圖層樣式、快速遮色片與進階色域選取（Phase 4）
- **圖層樣式（Layer Effects）**：支援邊界（銳利邊界／水彩邊界）、陰影、外發光與色彩覆蓋，完整對應 GPU 即時濾鏡、PNG/WebP/PSD/KRA 匯出管線與多人即時廣播／伺服器分享預覽圖。
- **快速遮色片（Quick Mask）**：按 `Q` 進入紅寶石半透明遮罩模式，以筆刷／橡皮擦精細修整選區而不影響原圖層像素，結束後無縫轉為選區並支援 Undo/Redo。
- **進階色域選取（Color Range）**：提供即時遮罩預覽、畫布滴管取色、容差／羽化／反相微調與一鍵套用選區；同步補齊單張 WebP 匯出。

### 6. 多人繪茶 2.0（Phase 5）
- **跟隨繪師視角（Follow Camera）**：精準同步目標畫師的平移、縮放、旋轉、水平鏡像與 DPI 座標轉換；按 `Esc` 或手動拖曳視窗即時解除跟隨，目標離線自動解除。
- **分格認領／接龍格線（Grid Slots）**：房主／管理員可建立 `M×N` 接龍分格，畫友一鍵認領、鏡頭自動定位至格位或釋放分格，搭配伺服器端衝突防護與 RBAC 權限檢查。
- **房間共用色票盤與共用參考圖板**：支援房間級色票同步與共用參考圖縮放／位置同步及管理員鎖定，且與個人本地 SubView 嚴格隔離。

### 7. 專業製作與效能收尾（Phase 6）
- **動畫時間軸音訊波形與 MP4/WebM 混音匯出（6.1）**：
  - 全新 `AudioWaveformCanvas.tsx` 以高 DPI `<canvas>` 繪製真實波形，完整反映 `trimStartSec` 裁剪起點、`endFrame` 截斷長度、音量縮放（並保留原音量幽靈外框）、靜音狀態與播放頭進度；支援於時間軸上直接橫向拖曳調整音軌 `startFrame` 偏移與行內快速靜音。
  - `packages/shared/src/animation/audio.ts` 與 `AudioTrackEngine.ts` 實作離線立體聲多軌 PCM 混音（支援跨取樣率線性重取樣與 `tanh` 軟限幅），由 `ExportEngine.ts` 透過 WebCodecs `AudioEncoder` + `mp4-muxer`（AAC／Opus）或 `webm-muxer`（Opus `A_OPUS`）封裝進影片；若無啟用音軌、音檔未關聯或裝置不支援音訊編碼器，皆自動安全降級為純影像匯出並顯示提示。
- **商業印刷真 CMYK 4 通道分色匯出與 TAC 警告（6.2）**：
  - `packages/shared/src/color/cmyk-separation.ts` 實作可調式 **GCR（灰成分替換）與 UCR（底色去除）**黑版生成模型，內建 Japan Color 2001 Coated（300%）、FOGRA39（330%）、US Web Coated SWOP（300%）與自訂參數（黑版強度、起始點、最大黑墨量、TAC 上限與自動限墨開關）。
  - `packages/shared/src/color/cmyk-export.ts` 提供原生 **Baseline TIFF 6.0 真 4 通道 CMYK 編碼器**（PackBits 無損壓縮、`PhotometricInterpretation = 5`、`SamplesPerPixel = 4`、`InkSet = 1`、DPI 與可選 ICC Tag `34675`）及 **Adobe Photoshop 真 4 通道 CMYK PSD 編碼器**（`8BPS`、`ColorMode = 4`、Adobe 反相墨量慣例、保留各點陣圖層與混合模式，並通過 `ag-psd` `readPsd` 交叉解析驗證）。
  - `ExportModal.tsx` 內嵌即時下採樣 **TAC 超限熱點預覽畫布**、峰值總墨量／超限面積佔比與四語系警告提示。
- **大畫布（4K～8K+）Tile GPU 紋理 LRU 池化與提交管線優化（6.3）**：
  - `packages/shared/src/tiles/tile-lru-pool.ts` 實作確定性 O(1) `TileGpuLruPool`，同時管控最大 Tile 數與 VRAM 位元組上限，搭配 85% 低水位遲滯與 Clean-first（零 GPU `readPixels`）淘汰順序。
  - `TileAtlas.ts` 新增閒置 17.8 MB 紋理頁溫熱重用池（`pagePool` + `trimPool`），減少 4K～8K+ 縮放平移時的 WebGL 紋理分配抖動。
  - `LayerManager.ts` 與 `TileEngine.ts` 導入 4K/8K 動態預設預算、執行期 `setGpuTileBudget` / `enforceTileLruBudgetNow` 控制、4K+ 自適應 PBO 池上限（96）與詳細 GPU／管線統計指標。

### 8. 後續功能增強與實機複測打磨
- **筆刷與文字增強**：新增 `.abr` v6.2 單筆刷／多筆刷群組匯出；升級本機字型庫掃描、可搜尋字型選擇器與橫直書快速切換。
- **即時畫布導覽器與大圖保護**：新增即時畫布導覽器（視口紅框拖曳、垂直翻轉）；強化 13500×7800 50 圖層載入／繪製／復原速度並修復縮小時 Mipmap 淡化問題；補齊行動端與多人 13500×7500 OOM／WebGL 紋理上限防護。
- **工具列、填色與獨立橡皮擦工具集**：折疊精簡主工具列獨立顯示文字、漫畫與動畫（共 14 類）；統一輔助工具集面板、分隔線與精簡描述；單一油漆桶上下屬性雙向同步；智能填色整合圍住塗抹與間隙補塗；新增獨立 5 款橡皮擦工具集（硬邊、軟邊、感壓大小、定寬無感壓、感壓透明）並支援四段抗鋸齒。
- **介面流暢度、六大材質與操作細節**：移除炫彩玻璃掉幀卡頓根因、升級流光霓虹雙流波動細項（RGB／單色／雙色／飽和度）並強化六大介面材質質感；變形工具綁定 `Ctrl+T`；支援自訂 `Shift`／`Ctrl+Shift` 滾輪旋轉角度；單機模式隱藏多人圖層協作 UI；大型多圖層 PSD 改為 `useRawData` 逐層串流裁切為 LZ4 瓦片，修復從 CSP 匯出大型 PSD 時發生 `Exceeded memory limit` 的問題；重編 Windows 安裝精靈 `LuminaGlassUI.dll` 提升 GroupBox 亮字可讀性；同步更新四語系 README 與完整翻譯鍵。

---

## 三、相容性與品質驗證紀錄

- **四語系覆蓋率（`i18n-coverage.check.ts`）**：`zh-TW` / `zh-CN` / `en-US` / `ja-JP` 各 **2,514** 個翻譯鍵 100% 齊全通過。
- **前端單元與演算法自檢（`ui-logic.check.ts`）**：全數通過，涵蓋 Phase 1 ～ Phase 6 全部檢查模組（含 `v15-phase6-pro-perf.checks.ts` 的波形裁剪／立體聲 PCM 混音、GCR/UCR 分色、TAC 熱圖、CMYK TIFF 位元級還原、CMYK PSD `ag-psd` 交叉驗證與 8K 50 波次 Tile LRU 壓測）。
- **全工作區與桌面建置**：`pnpm -r build` 與 `pnpm --filter @atelier/client build:electron` 全數通過。
- **後端完整整合測試（`pnpm --filter @atelier/server test`）**：19 項整合測試全數通過（含 Phase 19 多人繪茶 2.0 持久化、Socket 同步與 RBAC 權限）。
- **隔離式 Electron 桌面端煙霧測試**：
  - Phase 1 ～ Phase 5 各階段隔離式煙霧測試皆已於對應里程碑通過。
  - Phase 6 雙 Session 隔離式煙霧測試（`node apps/client/scripts/v15-phase6-pro-perf-electron-smoke.check.cjs`）通過，**0 console errors, 0 page errors**：
    - 6.1：真實 WAV 匯入、68 柱 `4,340 px` `<canvas>` 波形渲染、時間軸靜音切換、WebM 含音軌匯出（`18,999 B`）。
    - 6.2：215% TAC 超限警告即時觸發、真 4 通道 CMYK TIFF（`300,014 B`, `Photometric=5`, `4ch`）與 CMYK PSD（`126,026 B`, `ColorMode=4`, `4ch`）匯出驗證。
    - 6.3：`4096×4096` 4K 畫布多筆刷繪製與縮放後 GPU Tile LRU 受控淘汰（`tiles 62 -> 30`, `coldTiles=28`, `lruEvictions=32`, `atlasPages=1`, `pboHits=71`）。

---

## 四、v1.5.0 最終版建置產物（2026-11-28 驗證）

| 平台／元件 | 檔名 | 檔案大小 | 備註 |
| :--- | :--- | :--- | :--- |
| Windows 安裝精靈介面庫 | `LuminaGlassUI.dll` | `0.45 MB`（`471,552 B`） | x86 PE32 DLL，含 GroupBox 亮字修復 |
| Windows 安裝版（x64） | `Lumina-Drift-Paint-Setup-1.5.0.exe` | `133.26 MB`（`139,734,604 B`） | NSIS 安裝程式 |
| Windows 免安裝可攜版（x64） | `Lumina-Drift-Paint-Portable-1.5.0.exe` | `121.57 MB`（`127,479,118 B`） | 免安裝可攜執行檔 |
| Android（已簽章） | `Lumina-Drift-Paint-Android-1.5.0.apk` | `2.45 MB`（`2,571,247 B`） | 已通過 `apksigner` v2／v3 簽章驗證 |
| Web 靜態與自架包 | `Lumina-Drift-Paint-Web-1.5.0.zip` | `5.17 MB`（`5,425,434 B`） | 含前端靜態產物與伺服端部署結構 |
