# 版本變更紀錄

本文件記錄 Lumina Drift（流光）各版本的重要變更。

## [1.4.0] - 2026-11-26

### 新增

- **CSP 風格「主工具列 → 輔助工具組（Sub Tool）」架構與填充組整合（Phase 2）**：左側主工具列精簡為 11 個主分類（支援經典展開模式切換），新增 `SubToolPanel`、重複快捷鍵循環切換與子工具獨立參數記憶；整合 5 個填充子工具（參照其他圖層／僅參照編輯圖層油漆桶、圍住塗抹、套索塗抹，以及全新**間隙填充筆**），並同步適配平板／手機端觸控介面。
- **全工具組收斂與幾何選框補齊（Phase 3）**：補齊**矩形選框、橢圓選框與多邊形套索**（支援 Shift 等比／Alt 中心展開、取代／加選／減選、羽化與消除鋸齒）；完成選取（7 子工具）、向量（6 子工具，含向量橡皮擦局部擦除）、混色修整、圖形與漫畫工具組收斂，並於設定視窗拆分主工具分類與個別子工具快捷鍵（零衝突），維持外掛自訂工具相容。
- **繪師高頻輔助面板（Phase 4）**：新增可停靠／浮動的本機**子視圖（Sub View）參考圖面板**（`Ctrl+Shift+R`，支援多圖載入、縮放／翻轉／旋轉與自動吸色）、**色彩歷史紀錄**（支援固定色票與 `.aco`／`.gpl` 匯入匯出）、**迷你混色盤（Mixing Pad）**，以及桌面端**快顯輪盤（Pop-up Palette）**（支援右鍵／數位筆側鍵／`Alt+Q` 觸發設定）。
- **快速形狀、操控變形與四方連續平鋪（Phase 5）**：新增 Procreate 風格**快速形狀（QuickShape）**停筆自動吸附與拖曳調整、ARAP 演算法**操控變形（Puppet Warp，`Ctrl+Alt+P`）**（三角網格釘點拖曳與旋轉權重），以及**四方連續平鋪模式（Wrap-Around，`Alt+W`）**3×3 無縫即時檢視與跨邊界繪製／多人同步。
- **非破壞性調整圖層（Phase 6）**：正式啟用 `adjustment` 調整圖層，支援色相／飽和度／明度（HSL）、色階、色調曲線、色彩平衡、漸層對應、亮度／對比 6 種即時非破壞性調色，完整支援不透明度、混合模式、剪裁遮色片（`clipToBelow`）、圖層／群組蒙版與群組隔離，並支援單機／多人同步、`.lumina` 存讀與 `.psd` 對應。
- **自動動作／巨集與文字排版深化（Phase 7）**：新增**自動動作（Auto Actions）**面板與錄製引擎（12 種步驟、7 個內建預設動作、`.lumina-action` 匯入匯出，整段播放包裹於單步 `Ctrl+Z` 交易且支援失敗回滾）；升級**富文本文字引擎**，支援區段樣式（局部改色／字級／粗斜體）、字距行距、對齊、固定文字方塊自動換行、描邊置後（Stroke behind Fill）、陰影與直排漫畫標點避頭尾／括號旋轉。
- **商業印刷色彩管理與雙向 `.kra` 匯出（Phase 8）**：新增純本機檢視的 **CMYK 軟校樣（Soft Proofing）**與**超色域警告（Gamut Warning）**（內建 Japan Color 2001 Coated／FOGRA39／US Web Coated SWOP 近似模型，並支援匯入自訂 `.icc`／`.icm` 描述檔）；PNG／JPEG／PSD 匯出支援嵌入 RGB ICC Profile；新增**雙向 Krita `.kra` 匯出**，完整保留圖層樹群組、27 種混合模式、透明度蒙版、繼承 Alpha 剪裁與透明鎖定。

### 相容性與已知限制

- **`.lumina` 向下相容**：維持 `schemaVersion = 1`，既有舊版 `.lumina` 專案與純字串文字圖層皆可無縫開啟；含調整圖層的新專案於舊版軟體中僅會將該層視為未知圖層類型。
- **跨軟體匯出**：支援 `.kra`、`.psd`、`.ora`、多圖層 PNG ZIP 與單張 PNG／JPEG；其中調整圖層不寫入 `.kra` 結構（效果已烘焙於 `mergedimage.png`），匯出嵌入的 ICC 一律為 RGB 描述檔（CMYK 描述檔僅供軟校樣預覽）。
- **純本機輔助／檢視功能**：CMYK 軟校樣、超色域警告、子視圖（Sub View）與色彩歷史／混色盤皆為純本機狀態，不會透過 Socket 傳送或影響多人房間其他畫友的畫面與像素。

完整功能詳解、相容性細節、已知限制與回歸驗證紀錄見 [v1.3.2 → v1.4.0 完整更新總結](./CHANGELOG-v1.3.2-to-v1.4.0.md)。

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
