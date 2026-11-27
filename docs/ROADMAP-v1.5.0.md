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
| **Phase 2.5** | **工作區增強** | 懸浮視窗可伸縮圖標小球／膠囊 Dock（單視窗縮球、多視窗自動拉長膠囊、橫直切換、點擊展開切換、拖出拆球與磁吸合併） | `v1.5.0-alpha.3` | 單聊天室 | `已完成` | 2026-11-27 / `1eb83fd`, `112e793` |
| **Phase 3** | **P0-C** | 筆刷引擎 v3（雙筆刷、色彩動態、濕邊／顏料混色、多筆尖輪播與 `.sut`/`.brushset` 深度還原） | `v1.5.0-beta.1` | `/teamwork` | `已完成` | 2026-11-27 / `a1c2283`, `e140c1a` |
| **Phase 4** | **P1-A** | 非破壞性圖層樣式（Layer Effects：邊界／水彩邊界／陰影／發光）＋快速遮色片（Quick Mask）與進階色域選取 | `v1.5.0-beta.2` | `/teamwork` 或 `/swarm` | `已完成` | 2026-11-27 / `b128801`, `4767853`, `80b33bb` |
| **Phase 5** | **P1-B** | 多人繪茶 2.0（跟隨繪師視角、分格認領／接龍格線、房間共用色票盤與參考圖同步） | `v1.5.0-rc.1` | `/teamwork` | `已完成` | 2026-11-27 / `488335e`, `6d582ea`, `d9a19e2` |
| **Phase 6** | **P2** | 專業製作與效能收尾（動畫時間軸音訊波形＋混音匯出、真 CMYK 4 通道分色匯出、大畫布 Tile LRU 效能優化） | `v1.5.0` | `/teamwork` 或 `/swarm` | `已完成` | 2026-11-27 / `87d11bc`, `e4f6bed` |

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
- **下一階段接續點**：已穿插完成「Phase 2.5 工作區增強｜懸浮視窗可伸縮圖標小球／膠囊 Dock」，後續接續 Phase 3（P0-C：筆刷引擎 v3）。

---

### Phase 2.5（工作區增強）：懸浮視窗可伸縮圖標小球／膠囊 Dock
> **建議執行模式**：單聊天室
> **目標**：在不破壞既有左右下停靠欄與懸浮分頁的前提下，讓懸浮視窗與懸浮群組能一鍵收折成不遮擋畫布的圓形圖標小球或自動拉長膠囊，並支援橫／直式切換、拖曳定位、單圖標拆球與磁吸合併。

#### 任務清單
- [x] **2.5.1 狀態擴充與 v4→v5 平滑遷移（`dockStore.ts`）**
  - `DockLayoutState` 新增群組層級 `floatGroups: Record<string, FloatGroupState>`（含 `minimized`、`orientation: 'horizontal' | 'vertical'`、`pillPos`），版本升至 `v5` 並支援 `v4 → v5` 平滑遷移不遺失既有停靠與懸浮設定。
  - 新增 `minimizeFloatGroup`、`expandFloatGroup`、`setFloatGroupOrientation`、`toggleFloatGroupOrientation`、`setFloatGroupPillPos`、`detachToPill`、`mergePanelsInto` 與 `getFloatGroupState`，並確保 `activate`/`show`/`toggle`/`dockAt` 與拆出群組主分頁時狀態一致、不殘留髒資料。
- [x] **2.5.2 收折、展開、橫直切換、拆球與磁吸合併互動（`DockSystem.tsx`、`index.css`）**
  - 單視窗與多視窗懸浮標題列及浮動選單新增「縮小成小球」按鈕（停靠欄面板不受影響）。
  - 單視窗收折為圓形小球，多視窗分組依成員數自動拉長為圓角膠囊，支援橫式／直式一鍵切換、視口內自動 clamp 拖曳定位，以及點擊任一圖標展開並切換顯示對應分頁。
  - 支援從多視窗膠囊拖出單一圖標到空白處獨立成新小球，支援小球／膠囊／單圖標拖曳至另一小球／膠囊（12px 磁吸半徑）自動合併拉長，並維持與展開懸浮視窗（合併分頁）及左／右／下停靠欄的 DnD 完整互通。
- [x] **2.5.3 專屬面板圖標、四語系與測試驗證**
  - 新增 `apps/client/src/components/workspace/panelIcons.tsx`，為 11 個面板提供互不重複的專屬 Lucide 圖標與四語系標題輔助，並同步整合至 `CanvasWorkspace.tsx`。
  - 補齊 `zh-TW`、`zh-CN`、`en-US`、`ja-JP` 四語系 `dock` 命名空間（各新增 50 個鍵值，總計 2358 keys 100% 齊全），並完成單元測試與隔離式 Electron 煙霧測試。

#### 交接紀錄
- **完成日期**：2026-11-27
- **相關提交**：
  - `1eb83fd`：`feat(dock): add floating pill group state, v4->v5 migration, panel icons, and locales`
  - `112e793`：`feat(client): add collapsible floating icon pills, capsule orientation toggle, and magnetic merge/detach DnD`
- **實際驗證結果**：
  - `i18n-coverage.check.ts`：通過（四語系各 2358 keys 100% 齊全）。
  - `ui-logic.check.ts`：通過（含 `apps/client/scripts/dock-pill.checks.ts` 的 v4→v5 遷移、縮球、橫直切換、拆球、磁吸合併、停靠清理、11 專屬圖標與四語系斷言）。
  - `pnpm -r build`：通過（`@atelier/shared`、`@atelier/server`、`@atelier/client` 全數編譯成功）。
  - `pnpm --filter @atelier/client build:electron`：通過。
  - 隔離式 Electron 煙霧測試 `node apps/client/scripts/v15-dock-pills-electron-smoke.check.cjs`：通過（`0 console errors, 0 page errors`；實測 v4→v5 遷移、單視窗縮球與拖曳定位、小球磁吸互併拉長、橫直一鍵切換、點擊指定圖標展開切換分頁、多視窗膠囊拖出拆球、三球合併與膠囊圖標拖回右側停靠欄）。
- **下一階段接續點**：Phase 3（P0-C：筆刷引擎 v3——雙筆刷、色彩動態、濕邊／顏料混色、多筆尖輪播與 `.sut`/`.brushset` 深度還原）。

---

### Phase 3（P0-C）：筆刷引擎 v3（雙筆刷、色彩動態、濕邊／顏料混色與外部格式深化）
> **建議執行模式**：`/teamwork`
> **目標**：強化專業插畫與厚塗手感，提升 `.sut` / `.brushset` 匯入還原度。

#### 任務清單
- [x] **3.1 雙筆刷（Dual Brush）與多筆尖隨機輪播**
  - `DualBrushBlendMode` 擴充至 5 種混合模式（`multiply` / `subtract` / `darken` / `screen` / `overlay`，`screen`/`overlay` 經 `dst-in` 裁切不滲出透明背景），新增 7 種副筆尖形狀（`same` / `round` / `soft` / `speckle` / `bristle` / `square` / `custom`）與 `dualSpacing` 間距距離累積控制。
  - 新增 `tipUrls` 與 `tipPlayMode`（`single` / `sequential` / `random` / `randomNoRepeat`），搭配共享層 `selectBrushTipIndex` 與 `BrushRenderer` 多筆尖貼圖載入／回收管理及 UI 縮圖管理。
- [x] **3.2 色彩動態（Color Dynamics：HSL 隨機／壓感／筆劃漸變抖動）**
  - 新增 `BrushColorDynamicsConfig`、`rgbToHsl`/`hslToRgb`、`normalizeColorDynamics` 與 `evaluateColorDynamics`，明確區分 `perDab`（每印記）與 `perStroke`（每筆劃）範圍，支援 HSL 隨機抖動、筆壓偏移、筆劃距離漸變（`gradientLength`）與主副色筆劃漸變（`fgBgGradient`）。
- [x] **3.3 濕邊（Watercolor Edge）與進階顏料混色（Pigment Blending）**
  - 濕邊擴充為可調參數 `wetEdgeStrength`、`wetEdgeWidth`、`wetEdgeDarkness`，透過 `computeWetEdgeParams` 與獨立 `wetRimRT` 實現水彩中心稀釋與外緣毛細沉積暗邊渲染。
  - 新增 `PigmentBlendModel`（`subtractive` / `oklab` / `rgb`）、`blendPigmentColors`、`stepPigmentReservoir` 與 `chargeDepletion` 枯筆衰減，即時接入 `BrushRenderer` 儲墨槽混色與主副色混合。
- [x] **3.4 `.sut` / `.brushset` 雙筆刷與紙紋參數深度映射與回歸測試**
  - `SutParser`、`ProcreateParser` 與 `BrushPackageManager` 完整支援雙筆刷設定與副筆尖貼圖、多筆尖輪播清單、每筆／每印記與壓感色彩動態、水彩濕邊、減色顏料混色與紙紋混合模式／對比還原，並透傳至預設儲存／套用與外掛介面。
  - 補齊 `zh-TW` / `zh-CN` / `en-US` / `ja-JP` 四語系（各新增 37 個鍵值，總計 2395 keys 100% 齊全），並完成單元測試、後端測試與隔離式 Electron 煙霧測試。

#### 交接紀錄
- **完成日期**：2026-11-27
- **相關提交**：
  - `a1c2283`：`feat(shared): add Brush Engine v3 dynamics, subtractive pigment blending, and deep .sut/.brushset parsing`
  - `e140c1a`：`feat(client): implement Brush Engine v3 rendering, UI controls, 4 locales, and regression tests`
- **實際驗證結果**：
  - `i18n-coverage.check.ts`：通過（四語系各 2395 keys 100% 齊全）。
  - `ui-logic.check.ts`：通過（含 `apps/client/scripts/v15-phase3-brush-v3.checks.ts` 的多筆尖輪播、HSL 每筆／每印記／壓感／漸變色彩動態、濕邊與減色顏料混色、`.sut` SQLite 與 `.brushset` ZIP/plist 深度映射、預設與四語系斷言）。
  - `pnpm -r build`：通過（`@atelier/shared`、`@atelier/server`、`@atelier/client` 全數編譯成功）。
  - `pnpm --filter @atelier/client build:electron`：通過。
  - `pnpm --filter @atelier/server test`：18 項後端整合測試全數通過（含 `test-phase6-voice-stickers-brushes.ts` 的 v3 `.asbrush` 匯出匯入往返驗證）。
  - 隔離式 Electron 煙霧測試 `node apps/client/scripts/v15-phase3-brush-v3-electron-smoke.check.cjs`：通過（`0 console errors, 0 page errors`；實測 v3 全部 UI 切換與即時筆劃預覽、濕邊＋雙筆刷實際繪製 3540 非空像素、黃覆藍減色顏料混色 `avgExcessG = 17.69` 顯著高於 RGB `4.28`、每印記色彩動態 40 個 RGB 色彩桶，以及 `.brush` 檔案匯入後還原 `dualBrush`/`wetEdges`/`subtractive`/`perStroke`）。
- **下一階段接續點**：Phase 4（P1-A：非破壞性圖層樣式 Layer Effects＋快速遮色片 Quick Mask 與進階色域選取）。

---

### Phase 4（P1-A）：非破壞性圖層樣式（Layer Effects）＋快速遮色片與進階色域選取
> **建議執行模式**：`/teamwork` 或 `/swarm`
> **目標**：讓邊界描邊、水彩邊界、陰影／發光全面非破壞化，並強化精準選區工作流。

#### 任務清單
- [x] **4.1 非破壞性圖層／資料夾樣式管線（邊界效果：外框／水彩邊界、外陰影、外發光、顏色覆蓋）**
- [x] **4.2 快速遮色片（Quick Mask）紅膜塗抹選取模式**
- [x] **4.3 進階色域選取對話框（即時遮罩預覽、吸管加減採樣、容差與羽化）**
- [x] **4.4 匯出合成支援、四語系與測試驗證**

#### 交接紀錄
- **完成日期**：2026-11-27
- **相關提交**：
  - `b128801`：`feat(shared): add non-destructive Layer Effects renderer and Color Range selection core`
  - `4767853`：`feat(server): support Layer Effects persistence, realtime broadcast, share preview, and tests`
  - `80b33bb`：`feat(client): add Layer Effects GPU/export pipeline, Quick Mask, Color Range dialog, WebP export, 4 locales, and tests`
- **實際驗證結果**：
  - `i18n-coverage.check.ts`：通過（四語系各 2447 keys 100% 齊全，涵蓋圖層樣式、快速遮色片、色域選取與 WebP 匯出）。
  - `ui-logic.check.ts`：通過（含 `apps/client/scripts/v15-phase4-effects-selection.checks.ts` 的圖層／資料夾樣式驗證與 CPU 參考渲染、色域選取加減採樣／容差／羽化／反轉與快捷鍵 `KeyQ` 無衝突斷言）。
  - `pnpm -r build`：通過（`@atelier/shared`、`@atelier/server`、`@atelier/client` 全數編譯成功）。
  - `pnpm --filter @atelier/client build:electron`：通過。
  - `pnpm --filter @atelier/server test`：18 項後端整合測試全數通過（含 `test-phase18-adjustment-layers.ts` 的圖層／資料夾 `meta.effects` 持久化、格式驗證、`layer_updated` 即時多人廣播與清除測試）。
  - 隔離式 Electron 煙霧測試 `node apps/client/scripts/v15-phase4-effects-selection-electron-smoke.check.cjs`：通過（`0 console errors, 0 page errors`；實測圖層樣式外框即時渲染 `edgeBorderRedPx=5776`、水彩邊界／陰影／發光／顏色覆蓋切換、Quick Mask 紅膜塗抹 `quickMaskPx=3657` 不污染底層像素且支援橡皮擦減選／`Ctrl+Z` 復原／按 `Q` 轉回選區、色域選取對話框即時預覽與吸管採樣套用 `colorRangePx=7196`，以及實際匯出 PNG `pngRedPx=5824`、WebP `webpRedPx=5360`、PSD `80705` bytes `8BPS` 與 KRA `32259` bytes `PK`）。
- **下一階段接續點**：Phase 5（P1-B：多人繪茶 2.0 — 跟隨特定繪師視角、畫布分格認領／接龍格線模式、房間共用色票盤與參考圖板同步）。

---

### Phase 5（P1-B）：多人繪茶 2.0
> **建議執行模式**：`/teamwork`
> **目標**：提升大型多人共創與繪茶房的互動、分工與觀摩體驗。

#### 任務清單
- [x] **5.1 跟隨特定繪師視角（Follow Camera）與即時在線狀態強化**
  - 於 `packages/shared/src/collab/collab-room.ts` 建立螢幕尺寸／DPI 無關的 `viewportStateToCamera` 與 `cameraToViewportState` 雙向換算，並擴充 `RoomMemberInfo` 支援 `activeTool`、`followingUserId`、`followerCount`。
  - 後端 `apps/server/src/realtime/room-manager.ts` 新增 `viewport_sync`、`member_tool`、`follow_target` 即時廣播、最新視口快取（按下跟隨即刻對齊）與斷線自動解除跟隨。
  - 前端 `SocketContext.tsx`、`UserListPanel.tsx` 與 `CanvasWorkspace.tsx` 實作節流視口廣播（75ms 含尾包刷新）、一鍵跟隨按鈕、被跟隨人數／目前使用工具徽章、頂部跟隨狀態膠囊條，以及拖曳／縮放／旋轉畫布或按 `Esc` 立即解除跟隨。
- [x] **5.2 畫布分格認領／接龍格線模式（Grid Slots & Claiming）**
  - 後端新增 SQLite `canvas_collab_state` 持久化表與 `apps/server/src/services/collab-room.service.ts`、`GET /api/canvases/:id/collab-state`，搭配 `grid_config_update`、`grid_slot_claim`、`grid_slot_release` 角色權限控管（僅房主／管理員可調整格數與開關；一般畫師可認領與釋放自己格子；旁觀／訪客唯讀）。
  - 前端新增 `GridSlotsOverlay.tsx`（支援平移／縮放／旋轉／鏡像的畫布分格疊層與可點擊認領標籤）與 `GridSlotsPopover.tsx`（格數預設、認領／釋放、一鍵聚焦定位至該格），並相容單機離線持久化（`collabLocalStore.ts`）。
- [x] **5.3 房間共用色票盤與參考圖板同步**
  - `ColorWheelStudio.tsx` 新增「房間共用色票」分區，支援即時同步新增／刪除（新增者本人或房主／管理員可刪）／點選套用，旁觀者與訪客僅可點選套用不可異動。
  - 新增 `RoomReferenceBoard.tsx` 並於 `SubViewPanel.tsx` 頂部提供「個人參考／房間參考板」雙頁籤切換，完整保留個人本地 `SubView` 不受干擾；共用參考圖板支援圖片上傳壓縮、拖曳位移、縮放、點擊吸色、即時同步與房主／管理員鎖定模式。

#### Phase 5 交接紀錄（2026-11-27）
- **已完成提交**：
  - `488335e`：`feat(shared): add Collab 2.0 camera math, grid slots, room swatches, and reference board core`
  - `6d582ea`：`feat(server): add Collab 2.0 SQLite persistence, realtime Socket sync, RBAC, and integration tests`
  - `d9a19e2`：`feat(client): add Follow Camera, Grid Slots claiming, Room Swatches, Shared Reference Board, 4 locales, and dual-window smoke test`
- **實際驗證結果**：
  - `i18n-coverage.check.ts`：通過（四語系 `zh-TW` / `zh-CN` / `en-US` / `ja-JP` 各 2489 keys 100% 齊全）。
  - `ui-logic.check.ts`：通過（含 `apps/client/scripts/v15-phase5-collab-v2.checks.ts` 的跟隨視角旋轉／鏡像／DPI 雙向轉換、分格認領衝突與縮格裁剪、共用色票／參考圖驗證與 RBAC 權限斷言）。
  - `pnpm -r build` 與 `pnpm --filter @atelier/client build:electron`：全數通過。
  - `pnpm --filter @atelier/server test`：19 項後端整合測試全數通過（含新增 `apps/server/tests/test-phase19-collab-v2.ts` 的多人跟隨視角、斷線自動解除、分格認領權限、共用色票／參考圖鎖定與重連／REST 持久化驗證）。
  - 隔離式雙視窗 Electron 煙霧測試 `node apps/client/scripts/v15-phase5-collab-v2-electron-smoke.check.cjs`：通過（`0 console errors, 0 page errors`；啟動 `PORT=0` 臨時隔離伺服器與兩個獨立 `APPDATA`/`LOCALAPPDATA`/`--user-data-dir` Electron 實例，實測工具狀態同步、跟隨視角同步 `followRotation=0.35`、`Esc` 與手動拖曳解除跟隨、2×3 分格認領／一鍵定位／釋放、共用色票 `#3B82F6` 同步套用、共用參考圖縮放 `refScale=1.25` 與管理員鎖定，且個人本地 SubView 維持 `1 / 1` 不受干擾）。
- **備註**：本次執行期間 Codex CLI 達方案額度上限（提示於 2026-12-01 重置），已依交接指示由主代理直接接續完成並通過全套驗證。
- **下一階段接續點**：Phase 6（P2：專業製作與效能收尾 — 動畫時間軸音訊波形渲染與 MP4/WebM 混音匯出、真 CMYK 4 通道分色匯出＋GCR/UCR 黑版設定與總墨量警告、大畫布 4K～8K+ Tile GPU 紋理 LRU 池化與提交管線效能壓測優化，以及 `v1.5.0` 全功能回歸與發布文件整理）。

---

### Phase 6（P2）：專業製作與效能收尾
> **建議執行模式**：`/teamwork` 或 `/swarm`
> **目標**：補齊動畫音訊混音輸出、商業印刷真 CMYK 分色與超大畫布穩定度。

#### 任務清單
- [x] **6.1 動畫時間軸音訊波形渲染與 MP4/WebM 音軌混音匯出**
  - 於 `packages/shared/src/animation/audio.ts` 補齊 `sliceWaveformPeaksForClip`（精準對應 `trimStartSec`、`endFrame`、音量縮放與靜音幽靈波形）、`planExportAudioMix`（匯出區間多軌排程與靜音／範圍過濾）與確定性立體聲取樣率重取樣混音器 `mixPcmChannels`（具 `tanh` 軟限幅保護）。
  - 新增 `apps/client/src/components/AudioWaveformCanvas.tsx`（高 DPI `<canvas>` 真實波形繪製、中心基準線、音量衰減與靜音殘影、播放頭進度高亮），整合至 `AnimationTimelineBar.tsx` 並支援時間軸上直接橫向拖曳音軌調整 `startFrame` 偏移、行內音量顯示與靜音切換。
  - 於 `AudioTrackEngine.ts`、`videoExport.ts`、`ExportEngine.ts` 與 `AnimationExportModal.tsx` 實作離線立體聲 PCM 混音與 WebCodecs `AudioEncoder` + `mp4-muxer`（AAC／Opus）／`webm-muxer`（Opus `A_OPUS`）音軌封裝，同時補齊 MediaRecorder 相容備援、MP4/WebM 容器切換、包含音軌開關，以及無音軌／未關聯／裝置不支援編碼器時之自動降級純影像匯出。
- [x] **6.2 真 CMYK 4 通道分色匯出（TIFF / PSD）＋GCR/UCR 黑版設定與總墨量警告**
  - 新增 `packages/shared/src/color/cmyk-separation.ts`：實作真 CMYK 4 通道分色演算法（支援 Japan Color 2001 Coated 300%、FOGRA39 330%、US Web Coated SWOP 300% 與自訂參數）、**GCR（灰成分替換）與 UCR（底色去除）**黑版生成模式、黑版強度／起始點／最大 K 值控制，以及**總墨量（TAC）分析、超限自動縮放與超限熱點預覽遮罩**。
  - 新增 `packages/shared/src/color/cmyk-export.ts`：實作無損 PackBits RLE 壓縮的 **Baseline TIFF 6.0 真 4 通道 CMYK 編碼器**（`PhotometricInterpretation = 5`、`SamplesPerPixel = 4`、`BitsPerSample = [8,8,8,8]`、`InkSet = 1`、DPI 與可選 ICC Tag `34675`）與 **Adobe Photoshop 真 4 通道 CMYK PSD 編碼器**（`8BPS`、`ColorMode = 4`、Adobe 反相墨量慣例、保留各點陣圖層與混合模式、DPI `0x03ED` 與可選 ICC `0x040F`，並通過第三方 `ag-psd` `readPsd` 交叉驗證）。
  - 於 `ExportEngine.ts` 與 `ExportModal.tsx` 新增 `cmyk_tiff`（`.tif`）與 `cmyk_psd`（`.psd`）匯出格式及即時 TAC 超限預覽畫布與警告橫幅，並補齊四語系翻譯。
- [x] **6.3 大畫布（4K～8K+）Tile GPU 紋理 LRU 池化與提交管線效能壓測優化**
  - 新增 `packages/shared/src/tiles/tile-lru-pool.ts`：實作確定性 O(1) `TileGpuLruPool`（雙指標上限：Tile 數量 + VRAM 位元組、85% 低水位遲滯防抖動、優先淘汰零 `readPixels` 的 Clean 離屏 Tile 再依自適應批次上限淘汰 Dirty Tile，且嚴格保護視窗內與釘選 Tile）及依畫布解析度（4K / 8K+）與記憶體動態計算預算的 `computeRecommendedGpuTileBudget`。
  - 升級 `TileAtlas.ts` 新增閒置 Atlas 頁面溫熱重用池（`pagePool`、`setMaxPooledPages`、`trimPool` 與碎片率／命中率統計），避免 4K～8K+ 縮放平移期間反覆銷毀／重建 17.8 MB WebGL 紋理頁。
  - 升級 `LayerManager.ts` 與 `TileEngine.ts`：整合動態 4K/8K 紋理與位元組上限、Clean-first LRU 淘汰與 `setGpuTileBudget` / `enforceTileLruBudgetNow`、自適應 PBO 池上限（4K+ 提升至 96）與 `getTextureStats()` / `getPipelineStats()` 監控指標。
- [x] **6.4 `v1.5.0` 全功能回歸測試與發布文件整理**
  - 補齊四語系（`zh-TW` / `zh-CN` / `en-US` / `ja-JP`）新增 25 個 Phase 6 翻譯鍵並通過 `i18n-coverage.check.ts`（各 2514 keys 100% 齊全）。
  - 撰寫 `apps/client/scripts/v15-phase6-pro-perf.checks.ts` 掛載進 `ui-logic.check.ts`，以及雙 Session 隔離式桌面煙霧測試 `apps/client/scripts/v15-phase6-pro-perf-electron-smoke.check.cjs`。
  - 整理 [docs/CHANGELOG.md](./CHANGELOG.md) 與 [docs/CHANGELOG-v1.4.0-to-v1.5.0.md](./CHANGELOG-v1.4.0-to-v1.5.0.md) 完整發布說明。

#### 實作完成紀錄（2026-11-27）
- **Commit**：`87d11bc`（`@atelier/shared` 音訊波形／PCM 混音、真 CMYK 分色與 TIFF/PSD 編碼器、Tile GPU LRU 池核心）、`e4f6bed`（`@atelier/client` 時間軸波形畫布與 MP4/WebM 混音匯出、CMYK 匯出對話框與即時 TAC 警告、TileAtlas 頁面池與 LayerManager/TileEngine 優化、四語系與測試腳本），另含本筆 `docs(release)` 紀錄提交。
- **實際驗證結果**：
  - `i18n-coverage.check.ts`：通過（四語系 `zh-TW` / `zh-CN` / `en-US` / `ja-JP` 各 2514 keys 100% 齊全）。
  - `ui-logic.check.ts`：通過（含 `v15-phase6-pro-perf.checks.ts` 的波形裁剪／立體聲重取樣混音／軟限幅、GCR vs UCR 分色、TAC 警告熱圖、TIFF 6.0 CMYK 無損 round-trip、CMYK PSD `ag-psd` 交叉解析驗證、以及 8K 5 圖層 50 波次 Tile LRU 壓測）。
  - `pnpm -r build` 與 `pnpm --filter @atelier/client build:electron`：全數通過。
  - `pnpm --filter @atelier/server test`：19 項後端整合測試全數通過。
  - 隔離式 Electron 煙霧測試 `node apps/client/scripts/v15-phase6-pro-perf-electron-smoke.check.cjs`：通過（`0 console errors, 0 page errors`；Session 1 實測 6.1 音訊 WAV 匯入、68 柱 4340 px 真實波形畫布渲染、靜音切換、WebM 含音軌匯出 `18,999 B`，以及 6.2 CMYK TAC 215% 超限警告觸發、真 4 通道 CMYK TIFF `300,014 B` `Photometric=5/4ch` 與 CMYK PSD `126,026 B` `ColorMode=4/4ch` 匯出；Session 2 實測 6.3 4K `4096×4096` 畫布多筆刷繪製與視窗縮放後的 GPU Tile LRU 淘汰 `tiles 62 -> 30`, `coldTiles=28`, `lruEvictions=32`, `pboHits=71`）。
- **備註**：本次執行期間 Codex CLI 達額度上限（至 2026-12-01 重置），已依交接指示由主代理直接完成實作、驗證與文件整理。
- **下一步接續點**：`v1.5.0` 全數 6 個 Phase 皆已完成並於本地 `main` 分支驗證完畢；待使用者確認後，可進行版本號遞升（`1.4.0` → `1.5.0`）、建置多平台發布安裝包、建立 `v1.5.0` Git Tag 與推送至遠端發布。
