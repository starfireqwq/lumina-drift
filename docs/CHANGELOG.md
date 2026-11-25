# 版本變更紀錄

本文件記錄 Lumina Drift（流光）各版本的重要變更。

## [1.3.2] - 2026-11-26

### 修正（Hotfix）

- 修正單機匯入 `.lumina`、`.psd` 或 `.kra` 時誤刪第一張匯入根圖層的問題。`offlineStore.createCanvas` 曾回傳內部圖層陣列的參考，使匯入圖層混入待清理的預設圖層清單。修正 `offlineStore.ts` 與 `LuminaProjectEngine.ts`，並新增 `offline-restore.test.mts`（`92acac2`）。
- 修正單機非連續圖層編組（`groupLayers`）與批次移入群組（`moveLayersToGroup`）時，因逐層搬移與 `tidyLayerModels` 交錯觸發而顛倒相對上下順序的問題。修正 `layer-tree.ts`、`CanvasWorkspace.tsx` 與 `LayerPanel.tsx`，並補齊 `layer-groups.test.mts`（`abfb6d9`）。
- 修正伺服端 Phase 6 測試 `test-phase6-voice-stickers-brushes.ts`，以帶有 JWT 的已認證帳號測試貼圖新增、更新與刪除同步，並驗證匿名訪客寫入貼圖時會因房間存取控制（Room ACL）收到 `PERMISSION_DENIED`（`5112367`）。
- 修正 Krita `.kra` 匯入時的剪裁遮色片轉換。`kraDecoder.ts` 與 `ExternalProjectImporter.ts` 將 `inheritsalpha="1"` 轉為 `clipToBelow`，並相容 `inheritalpha` 與 `inheritAlpha`，同時補齊 `external-project-import.test.mts`（`a4f8276`）。

完整修復細節、驗證紀錄與發佈清單見 [v1.3.0 → v1.3.2 完整更新總結](./CHANGELOG-v1.3.0-to-v1.3.2.md)。

## [1.3.1] - 2026-11-24

### 新增

- 支援匯入 Adobe Photoshop（`.psd`）與 Krita（`.kra`）檔案，保留圖層與巢狀群組、混合模式、不透明度、顯示狀態、剪裁遮色片、透明鎖定，以及圖層／群組蒙版。單機與多人聯機協作皆可將檔案拖曳至視窗開啟，或透過檔案選單與 `Ctrl+O` 匯入（`c33c8cb`）。
- 在圖層面板按住 `Shift + 左鍵拖曳` 可連續選取圖層。拖曳到清單邊緣時會自動捲動，按住 `Ctrl+Shift` 可保留原選取並加選（`f7e84d1`）。

### 修正

- 修正非連續圖層編組後的排序與收合異常，使選取圖層在新群組內連續排列，收合時一併隱藏（`f7e84d1`）。

## [1.3.0] - 2026-11-24

### 新增

- 推出 Procraft 多指觸控手勢、炫彩玻璃模式、筆刷引擎 v2、專業 2D 動畫、濾鏡庫、漫畫對話框與圖層對齊工具，並升級外掛 API 和多人房間權限。

完整內容見 [CHANGELOG-v1.2.0-to-v1.3.0.md](./CHANGELOG-v1.2.0-to-v1.3.0.md)。
