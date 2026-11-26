# Lumina Drift（流光）v1.5.0 專業繪圖演進分階段實作藍圖（Phase 1 ～ Phase 6）

> **文件用途**：作為跨聊天室接續開發的唯一事實來源（Single Source of Truth）。每次切換聊天室開始或結束一個 Phase 時，請更新本文件的「總覽進度表」與對應 Phase 的核取方塊（`- [x]`）及交接紀錄，確保不會遺漏任何需求與已驗證脈絡。
>
> **基準版本**：`v1.4.0`（commit `247c7e9`）
> **適用專案**：`C:\Users\KHUser\Downloads\lumina-drift-open-source`
> **明確排除項目**：本藍圖**不包含**「3D 基礎幾何／3D 人偶參考」功能（依專案方向刻意略過，請勿自行加回）。

---

## 一、總覽進度表（跨聊天室追蹤）

| 階段 | 優先級 | 主題 | 對應版本目標 | 建議執行模式 | 狀態 | 最後更新 / Commit |
| :--- | :---: | :--- | :---: | :---: | :---: | :--- |
| **Phase 1** | **P0-A** | CSP 圖層／資料夾面板標籤色、草稿染色與「用紙」底色系統（單機完整＋多人雙軌） | `v1.5.0-alpha.1` | 單聊天室 | `已完成` | 2026-11-27 / `4f91d70`, `336ad90` |
| **Phase 2** | **P0-B** | 尺規系統 v2（集中線／放射狀尺規、曲線／貝茲特殊尺規、圖層綁定尺規與透視空間網格） | `v1.5.0-alpha.2` | 單聊天室 或 `/teamwork` | `已完成` | 2026-11-27 / `e5e0ce5`, `292f54d` |
| **Phase 3** | **P0-C** | 筆刷引擎 v3（雙筆刷、色彩動態、濕邊／顏料混色、多筆尖輪播與 `.sut`/`.brushset` 深度還原） | `v1.5.0-beta.1` | `/teamwork` | `待啟動` | — |
| **Phase 4** | **P1-A** | 非破壞性圖層樣式（Layer Effects：邊界／水彩邊界／陰影／發光）＋快速遮色片（Quick Mask）與進階色域選取 | `v1.5.0-beta.2` | `/teamwork` 或 `/swarm` | `待啟動` | — |
| **Phase 5** | **P1-B** | 多人繪茶 2.0（跟隨繪師視角、分格認領／接龍格線、房間共用色票盤與參考圖同步） | `v1.5.0-rc.1` | `/teamwork` | `待啟動` | — |
| **Phase 6** | **P2** | 專業製作與效能收尾（動畫時間軸音訊波形＋混音匯出、真 CMYK 4 通道分色匯出、大畫布 Tile LRU 效能優化） | `v1.5.0` | `/teamwork` 或 `/swarm` | `待啟動` | — |

---

## 二、共通開發與驗證紀律（所有 Phase 皆須遵守）

1. **遵守 [AGENTS.md](../AGENTS.md)**：先定位再讀取（單次最多 150 行，禁止整份讀取大型檔案）、保留現有工作樹與 `AGENTS.md` / `apps/server/data/`、嚴格保護 Port 3000 常駐伺服器、PowerShell 禁止使用 `&&`。
2. **雙模型協作（Orchestrator + Codex CLI）**：主代理負責定位、規格拆解、Diff 審查、驗證與分批提交；程式碼實作、翻譯與單元測試一律派發給 `codex exec -m gpt-6.2-sol -c project_doc_max_bytes=0 -c model_reasoning_effort="xhigh" -s workspace-write -C <專案根目錄> -o <暫存摘要檔>`。
3. **隔離 Electron 實測**：每次桌面端自動化測試必須使用獨立的 `APPDATA`、`LOCALAPPDATA` 與 `--user-data-dir`，以及 `PORT=0` 的臨時伺服器，絕不可影響本機日常環境。
4. **四語系同步**：所有新增 UI 文字必須同步補齊 `zh-TW`、`zh-CN`、`en-US`、`ja-JP`（`apps/client/src/locales/`），並通過 `i18n-coverage.check.ts`。
5. **單機與多人一致性**：所有畫布／圖層／工具狀態變更須明確區分離線單機（`offlineStore.ts`）與多人房間（Socket + Server ACL），避免多人房間內個人檢視操作干擾他人。
6. **公開操作前確認**：涉及遠端 `git push`、建立 tag 或公開發布前，必須先徵詢使用者同意。

---

## 三、分階段詳細規劃

### Phase 1（P0-A）：CSP 圖層／資料夾面板標籤色、草稿染色與「用紙」底色系統
> **建議執行模式**：單聊天室（跨 `packages/shared`、`apps/server`、`apps/client` 共享 `LayerMeta` 與 Socket 協定，循序拆單給 Codex CLI 實作與審查最穩）
> **目標**：完整復刻 Clip Studio Paint 高頻圖層視覺管理與底色工作流，並在多人繪茶房間提供不互相干擾的「雙軌制」體驗。

#### 任務清單
- [x] **1.1 共享型別與 Metadata 驗證（`@atelier/shared`）**
  - 擴充 `LayerMeta`：`paletteColor?: string | null`（面板標籤色 hex）、`layerColor?: { enabled: boolean; mainColor: string; subColor?: string } | null`（非破壞性草稿染色主色／副色）。
  - 定義 CSP 經典 8 組預設標籤色常數、色碼正規化與 `sanitizeLayerMetaForType` 驗證白名單，確保 `paletteColor` 與 `layerColor` 可安全用於 `raster` / `vector` / `group` / `text` 等一般圖層與資料夾（同時維持現有 32KB meta 上限與相容性）。
  - 新增純函式工具：計算有效面板標籤色（含資料夾繼承規則、多人本地覆寫與繪師色模式）、計算圖層／資料夾有效草稿染色設定，以及 2D 像素染色函式（供匯出合成與伺服器縮圖／預覽共用）。
- [x] **1.2 後端畫布底色即時廣播與 Metadata 驗證（`@atelier/server`）**
  - 確認 `PATCH /api/canvases/:id` 更新 `bgColor` 時進行 hex 驗證，並在更新成功後向房間 `canvas_<id>` 廣播 `canvas_updated`（含 `canvasId`、`bgColor`、`title` 等欄位），讓多人房間內成員即時同步房主調整的「用紙」顏色。
  - 擴充後端圖層 `meta` 測試與 `canvas` 更新測試，確保 `paletteColor` 與 `layerColor` 通過驗證且無權限越界。
- [x] **1.3 前端 PixiJS 染色濾鏡、畫布「用紙」透明切換與匯出合成（`@atelier/client` 引擎層）**
  - `LayerManager.ts`：
    - 支援「用紙（Paper）」底色即時切換與**透明底預覽開關**（`setPaperVisible(visible)` / `updateBackground(bgColor, visible)`；隱藏用紙時以透明棋盤格呈現畫布區域，而非實心色塊）。
    - 為一般圖層與資料夾（`group`）支援非破壞性 **Layer Color（草稿染色）PixiJS Filter**（依亮度／灰階將像素映射至 `mainColor`～`subColor`，資料夾開啟時整組同步染色；切換即時生效、完全不改動原始 Tile 像素）。
  - `layerComposite.ts` / `ExportEngine.ts`：匯出合成時套用同步啟用的 `layerColor`（及資料夾繼承染色），並遵循用紙可見狀態。
- [x] **1.4 圖層面板 UI、單機／多人雙軌狀態與四語系（`@atelier/client` UI 層）**
  - **面板標籤色（Palette Color）**：
    - 圖層面板頂部控制列新增 CSP 風格「標籤色下拉選單」（無色 + 8 組預設色 + 自訂色選擇器）；左側眼睛與核取框區塊依有效標籤色整條上色（與截圖視覺一致），資料夾設定後子圖層自動繼承（仍可個別覆寫）。
    - 多人模式雙軌：擁有者／房主可設定「共用標籤色（同步全房）」；任何成員皆可透過本地覆寫設定「我的分類色（存 `localStorage`，不干擾隊友）」，並在面板提供檢視模式切換（「共用色 / 個人色 / 依繪師代表色」）。
  - **草稿染色（Layer Color）**：
    - 圖層面板工具列新增 CSP 風格「變更圖層顏色（藍白雙框）」切換鍵＋主／副色快速選擇彈窗。
    - 單機模式直接寫入 `layer.meta.layerColor`；多人模式預設切換「本地預覽染色（不干擾隊友，任何可讀圖層／資料夾皆可使用）」，擁有者／房主可一鍵「同步染色給全房」。
  - **底部「用紙（Paper）」列**：
    - 圖層清單最底部固定顯示「用紙」列（眼睛按鈕切換透明底預覽＋色塊點擊選擇底色）。
    - 單機模式直接更新本地畫布 `bgColor`（`offlineStore.ts` 持久化）；多人模式中房主／管理員可同步更新全房 `bgColor`（並接收 `canvas_updated`），一般成員則切換「僅本地預覽底色」並附一鍵還原房間紙色按鈕。
  - 補齊 `zh-TW`、`zh-CN`、`en-US`、`ja-JP` 四語系翻譯與單元測試。

#### 驗收標準
- `pnpm -r build` 全部通過（無 TypeScript 錯誤）。
- `npx tsx apps/client/scripts/ui-logic.check.ts` 通過（含標籤色繼承、多人雙軌解析、草稿染色像素運算測試）。
- `npx tsx apps/client/scripts/i18n-coverage.check.ts` 通過（四語系鍵值 100% 齊全）。
- `pnpm --filter @atelier/server test` 全數通過。
- 隔離式 Electron 煙霧測試通過，確認單機模式下：標籤色（含資料夾繼承）、草稿染色、底部用紙換色與隱藏透明底皆無 Console 錯誤且運作正常。

#### 交接紀錄
- **完成日期**：2026-11-27
- **相關提交**：
  - `4f91d70`：`feat(layers): add shared palette/display color rules and canvas bgColor broadcast`
  - `336ad90`：`feat(client): add CSP layer palette color, draft tint filter, and paper controls`
- **實際驗證結果**：
  - `pnpm -r build`：通過（`@atelier/shared`、`@atelier/server`、`@atelier/client` 全數編譯成功）。
  - `apps/client/scripts/ui-logic.check.ts`：通過（含標籤色資料夾繼承、多人雙軌覆寫、高對比前景色與草稿染色像素運算斷言）。
  - `apps/client/scripts/i18n-coverage.check.ts`：通過（四語系各 2244 keys 100% 齊全）。
  - `pnpm --filter @atelier/server test`：全數通過（含 `paletteColor`／`layerColor` 驗證與 `PATCH /api/canvases/:id` `bgColor`＋`canvas_updated` 廣播測試）。
  - `pnpm --filter @atelier/client build:electron`：通過。
  - 隔離式 Electron 煙霧測試 `node apps/client/scripts/v15-phase1-layer-colors-electron-smoke.check.cjs`：通過（`0 console errors, 0 page errors`；實測單機紙色／透明底切換／標籤色／草稿染色，以及雙人房主同步紙色＋成員本地紙色與本地草稿染色互不干擾）。
- **下一階段接續點**：Phase 2（P0-B：尺規系統 v2——集中線／放射狀尺規、曲線／貝茲特殊尺規、圖層綁定尺規與透視空間網格，排除 3D 幾何／人偶）。

---

### Phase 2（P0-B）：尺規系統 v2（集中線／放射狀、曲線尺規、圖層綁定與透視網格）
> **建議執行模式**：單聊天室 或 `/teamwork`
> **目標**：在既有 `RulerManager` 基礎上補齊漫畫與背景繪製必備的進階尺規能力（不含 3D 幾何／人偶）。

#### 任務清單
- [x] **2.1 集中線／放射狀尺規（Radial Line）與特殊曲線／貝茲尺規**
  - `@atelier/shared`：`packages/shared/src/ruler/ruler-math.ts` 新增 `radial_line` 與 `curve` 模式、`snapRadialLinePoint`（穿過焦點與落筆點之射線精準投影）、`createDefaultCurveRuler`／`evaluateCurveSegment`／`sampleCurveRulerPoints`／`snapCurveRulerPoint`（支援三次貝茲、二次曲線、Catmull-Rom 樣條與閉合路徑，精準細化吸附）。
  - `@atelier/client`：`RulerOverlay.tsx` 提供集中線放射導引、中心留白參考圓與拖曳手柄，以及貝茲曲線錨點與切線控制柄畫布互動；`RulerControlsModal.tsx` 補齊射線數／留白半徑／曲線類型／閉合／增刪節點控制。
- [x] **2.2 CSP 式圖層綁定尺規（Ruler-on-Layer）與顯示範圍（全圖層／同資料夾／僅指定圖層）**
  - `@atelier/shared`：新增 `packages/shared/src/ruler/layer-ruler.ts`，擴充 `LayerMeta.ruler` 與 `sanitizeLayerMetaForType` 白名單驗證，提供 `normalizeLayerRulerMeta`、`isLayerRulerEffectiveForLayer` 與 `resolveActiveLayerRuler`（支援 `all_layers` / `same_folder` / `target_layer`、資料夾繼承與優先順序）。
  - `@atelier/client`：`RulerManager.ts` 實作 `syncLayerContext`、`clearDetachedMode` 與 `commitBoundLayerRuler`（支援多人房間他人圖層唯讀吸附保護）；`LayerPanel.tsx` 新增 CSP 風格三角尺徽章（點擊快速啟停／雙擊開啟設定）與右鍵選單；`CanvasWorkspace.tsx` 串接單機與多人同步。
- [x] **2.3 透視空間網格（XY / XZ / YZ 輔助網格與間距控制）**
  - 嚴格排除任何 3D 基礎幾何或 3D 人偶，於 `ruler-math.ts` 實作純 2D 透視空間網格 `computePerspectiveGridLines`（1/2/3 點透視、`xy`/`xz`/`yz` 三平面獨立開關、畫布邊界裁剪、間距與不透明度控制），並於 `RulerOverlay.tsx` 提供可拖曳網格基準點（Grid Origin）與分色參考線渲染。
- [x] **2.4 尺規互動控制點優化、四語系與測試驗證**
  - 補齊 `zh-TW`、`zh-CN`、`en-US`、`ja-JP` 四語系共 64 個尺規 v2 鍵值，並完成後端 API／單元測試、前端 `ui-logic` 測試與隔離式 Electron 煙霧實測。

#### 交接紀錄
- **完成日期**：2026-11-27
- **相關提交**：
  - `e5e0ce5`：`feat(rulers): add radial line, curve snapping, 2D perspective grid, and layer ruler rules`
  - `292f54d`：`feat(client): add Rulers v2 controls, 2D perspective grid overlay, and CSP layer-bound rulers`
- **實際驗證結果**：
  - `pnpm -r build`：通過（`@atelier/shared`、`@atelier/server`、`@atelier/client` 全數編譯成功）。
  - `pnpm --filter @atelier/server test`：全數通過（含 `test-phase9-rulers-screentone-liquify-meshwarp.ts` 新增的集中線／曲線吸附、2D 透視空間網格、`layer-ruler` 規則與後端 `meta.ruler` 建立／更新／清除／非法 400 測試）。
  - `i18n-coverage.check.ts`：通過（四語系各 2308 keys 100% 齊全）。
  - `ui-logic.check.ts`：通過（含 `apps/client/scripts/v15-phase2-rulers.checks.ts` 引擎與圖層綁定／唯讀／轉綁斷言）。
  - `pnpm --filter @atelier/client build:electron`：通過。
  - 隔離式 Electron 煙霧測試 `node apps/client/scripts/v15-phase2-rulers-electron-smoke.check.cjs`：通過（`0 console errors, 0 page errors`；實測單機集中線／曲線增節點與吸附／2D 透視 XY·XZ·YZ 網格／CSP 圖層綁定與範圍切換＋徽章啟停，以及雙人房間圖層尺規即時 Socket.IO 同步）。
- **下一階段接續點**：Phase 3（P0-C：筆刷引擎 v3——雙筆刷、色彩動態、濕邊／顏料混色與 `.sut`/`.brushset` 深度映射）；另使用者提出「懸浮視窗／群組收折為可伸縮橫／直式圖標小球（膠囊 Dock）」新構想，待使用者確認是否穿插於 Phase 3 之前實作。

---

### Phase 3（P0-C）：筆刷引擎 v3（雙筆刷、色彩動態、濕邊／顏料混色與外部格式深化）
> **建議執行模式**：`/teamwork`
> **目標**：強化專業插畫與厚塗手感，提升 `.sut` / `.brushset` 匯入還原度。

#### 任務清單
- [ ] **3.1 雙筆刷（Dual Brush）與多筆尖隨機輪播**
- [ ] **3.2 色彩動態（Color Dynamics：HSL 隨機／壓感／筆劃漸變抖動）**
- [ ] **3.3 濕邊（Watercolor Edge）與進階顏料混色（Pigment Blending）**
- [ ] **3.4 `.sut` / `.brushset` 雙筆刷與紙紋參數深度映射與回歸測試**

---

### Phase 4（P1-A）：非破壞性圖層樣式（Layer Effects）＋快速遮色片與進階色域選取
> **建議執行模式**：`/teamwork` 或 `/swarm`
> **目標**：讓邊界描邊、水彩邊界、陰影／發光全面非破壞化，並強化精準選區工作流。

#### 任務清單
- [ ] **4.1 非破壞性圖層／資料夾樣式管線（邊界效果：外框／水彩邊界、外陰影、外發光、顏色覆蓋）**
- [ ] **4.2 快速遮色片（Quick Mask）紅膜塗抹選取模式**
- [ ] **4.3 進階色域選取對話框（即時遮罩預覽、吸管加減採樣、容差與羽化）**
- [ ] **4.4 匯出合成支援、四語系與測試驗證**

---

### Phase 5（P1-B）：多人繪茶 2.0
> **建議執行模式**：`/teamwork`
> **目標**：提升大型多人共創與繪茶房的互動、分工與觀摩體驗。

#### 任務清單
- [ ] **5.1 跟隨特定繪師視角（Follow Camera）與即時在線狀態強化**
- [ ] **5.2 畫布分格認領／接龍格線模式（Grid Slots & Claiming）**
- [ ] **5.3 房間共用色票盤與參考圖板同步**

---

### Phase 6（P2）：專業製作與效能收尾
> **建議執行模式**：`/teamwork` 或 `/swarm`
> **目標**：補齊動畫音訊混音輸出、商業印刷真 CMYK 分色與超大畫布穩定度。

#### 任務清單
- [ ] **6.1 動畫時間軸音訊波形渲染與 MP4/WebM 音軌混音匯出**
- [ ] **6.2 真 CMYK 4 通道分色匯出（TIFF / PSD）＋GCR/UCR 黑版設定與總墨量警告**
- [ ] **6.3 大畫布（4K～8K+）Tile GPU 紋理 LRU 池化與提交管線效能壓測優化**
- [ ] **6.4 `v1.5.0` 全功能回歸測試與發布文件整理**
