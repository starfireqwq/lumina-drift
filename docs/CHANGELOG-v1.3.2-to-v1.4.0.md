# Lumina Drift（流光）v1.3.2 → v1.4.0 完整更新總結

> **比較基準**：`v1.3.2`（`9b8e713`，2026-11-26）→ `v1.4.0`（2026-11-26，整合專業化藍圖 Phase 2 ～ Phase 8 全部里程碑）

---

## 一、版本演進總覽

本次 `v1.4.0` 是一次大型專業繪圖工作流升級，完整整合[功能演進與專業化分階段實作藍圖](./ROADMAP-PRO-DRAWING-PHASES.md)中的 **Phase 2 至 Phase 8**，全面對齊 Clip Studio Paint、Krita、Photoshop 與 Procreate 的核心創作體驗，同時維持單機離線與多人即時協作的一致性。

| 藍圖階段 | 更新主題 | 核心亮點 |
| :--- | :--- | :--- |
| **Phase 2** | 主工具列 → 輔助工具組架構與填充組 | 11 主分類精簡工具列、`SubToolPanel`、重複快捷鍵循環、5 填充子工具與全新「間隙填充筆」 |
| **Phase 3** | 全工具組收斂與幾何選框補齊 | 矩形／橢圓選框、多邊形套索、向量橡皮擦局部擦除、主分類／子工具快捷鍵拆分 |
| **Phase 4** | 繪師高頻輔助面板 | 子視圖（Sub View）參考圖、色彩歷史（`.aco`/`.gpl`）、迷你混色盤、桌面快顯輪盤（Pop-up Palette） |
| **Phase 5** | 速寫、修形與無縫材質三大工具 | 快速形狀（QuickShape）、ARAP 操控變形（Puppet Warp）、四方連續平鋪（Wrap-Around） |
| **Phase 6** | 非破壞性調整圖層 | 6 種即時調整圖層（HSL／色階／曲線／色彩平衡／漸層對應／亮度對比），支援剪裁、蒙版與群組隔離 |
| **Phase 7** | 自動動作與文字排版引擎深化 | Auto Actions 錄製／單步復原播放／`.lumina-action` 分享；富文本區段、方塊換行、描邊置後與直排避頭尾 |
| **Phase 8** | 印刷色彩管理與雙向 `.kra` 匯出 | CMYK 軟校樣、超色域警告、自訂 `.icc`/`.icm` 與 RGB ICC 嵌入、完整 Krita `.kra` 雙向無損匯出 |

---

## 二、Phase 2 ～ Phase 8 新功能摘要

### 1. CSP 風格「主工具列 → 輔助工具組」與填充工具組（Phase 2）

- **精簡主工具列與參數記憶**：左側 `ToolRail` 收斂為 11 個主分類（亦保留「經典展開模式」切換），每個主分類自動記憶上次使用的子工具，重複按下主分類快捷鍵可於組內循環切換；各子工具各自保存容差、參照層、消除鋸齒、筆刷尺寸等設定至 `localStorage`。
- **5 合 1 填充工具組**：整合「油漆桶（參照其他圖層）」、「油漆桶（僅參照編輯圖層）」、「圍住塗抹（Close and Fill）」、「套索塗抹（Lasso Fill）」與全新**間隙填充筆（Paint Unfilled Area）**，可沿線稿邊界精準補滿微縫且不溢出線外，完整支援單步 `Ctrl+Z` 與多人 Tile 同步。

### 2. 全工具組收斂與幾何選框補齊（Phase 3）

- **幾何與多邊形選取**：新增**矩形選框**、**橢圓選框**（支援 `Shift` 等比、`Alt` 中心展開）與**多邊形套索**（逐點連線、`Backspace` 退點、雙擊／`Enter` 閉合、`Esc` 取消），全選取組 7 個子工具統一支援取代／加選／減選、消除鋸齒與羽化。
- **向量、混色、漫畫組整合與快捷鍵架構**：收斂向量 6 子工具（補齊向量橡皮擦「擦至交點／局部擦除／整條刪除」三模式）、混色修整 3 子工具與圖形／文字／漫畫 4 子工具；設定視窗清楚區分主分類與個別子工具快捷鍵，預設快捷鍵零衝突，並與 Plugin API v2.5 自訂外掛工具完全相容。

### 3. 子視圖、色彩歷史／混色盤與桌面快顯輪盤（Phase 4）

- **子視圖（Sub View）參考圖面板**：可停靠於 Dock 或浮動開啟（`Ctrl+Shift+R`），支援拖曳／選檔／剪貼簿多圖切換、獨立縮放／平移／水平翻轉／旋轉，游標移入即可直接吸色至主畫布；資料存於本機 IndexedDB，不佔多人房間頻寬。
- **色彩歷史紀錄與迷你混色盤（Mixing Pad）**：自動記錄最近使用的顏色並支援固定常用色票組與 `.aco`（v1/v2）／`.gpl` 色票檔匯入匯出；迷你混色盤提供本機獨立調色與揉色區域並即時吸色。
- **桌面端快顯輪盤（Pop-up Palette）**：支援於游標處喚出「HSV 色環＋最近色票＋常用筆刷與子工具」三層輪盤（具視窗邊界防裁切定位），可於設定自訂右鍵／數位筆側鍵／僅快捷鍵（`Alt+Q`）觸發方式。

### 4. 快速形狀、操控變形與四方連續平鋪（Phase 5）

- **快速形狀（QuickShape）**：筆刷收筆停頓可自動辨識並吸附為直線、圓弧、圓形、橢圓、三角形與矩形／四邊形，按住不放拖曳即可調整角度、端點與尺寸（可於設定自訂延遲與開關）。
- **操控變形（Puppet Warp，`Ctrl+Alt+P`）**：自動依圖層非透明區域或選區建立三角網格，支援新增／拖曳／刪除釘點與旋轉權重，採 ARAP（As-Rigid-As-Possible）演算法減少扭曲與黑邊，確認後一次性寫入 Tile 並同步多人房間。
- **四方連續平鋪模式（Wrap-Around，`Alt+W`）**：提供 3×3 無縫重複檢視，筆刷、橡皮擦、揉色、模糊、油漆桶與形狀工具皆支援跨邊界 Modulo 環繞繪製與多人即時同步。

### 5. 非破壞性調整圖層（Phase 6）

- **6 種即時調整類型**：支援色相／飽和度／明度（HSL）、色階（Levels）、色調曲線（Curves，RGB 與單通道）、色彩平衡（Color Balance）、漸層對應（Gradient Map）與亮度／對比（Brightness/Contrast）。
- **完整合成規則與一致性**：支援調整圖層不透明度、混合模式、剪裁遮色片（`clipToBelow`）、圖層蒙版與群組作用範圍隔離，即時 GPU 預覽與 CPU 匯出公式對齊；雙擊隨時重編參數且不改動下層像素，支援單步復原、多人同步、`.lumina` 儲存與 `.psd` 常見調整層轉換。

### 6. 自動動作／巨集與文字排版引擎深化（Phase 7）

- **自動動作（Auto Actions）**：可停靠於 Dock 或於行動端 sheet 開啟，支援錄製、暫停、合併連續滑桿、步驟編輯／排序／單步停用與一鍵播放（涵蓋 12 種常用圖層／濾鏡／調整／選區指令），內建 7 個實用預設動作並支援 `.lumina-action` JSON 匯入匯出。整段播放包裹於單一 `groupId` 交易中，一次 `Ctrl+Z` 即可完整復原，任一步失敗自動回滾。
- **文字排版引擎深化**：支援富文本區段（局部改色、字級、粗體／斜體）、字距與行距微調、靠左／置中／靠右對齊、可拖曳固定文字方塊自動換行、**描邊置後（Stroke behind Fill）**與陰影效果，並進一步強化直排（縱書）漫畫標點避頭尾、括號旋轉與小寫假名排版。

### 7. 商業印刷色彩管理與雙向 `.kra` 匯出（Phase 8）

- **CMYK 軟校樣與超色域警告**：透過「檢視 → 色彩校樣」開關軟校樣與斜線高亮超色域警告；內建 Japan Color 2001 Coated、FOGRA39、US Web Coated SWOP 三組公開目標值近似印刷模型，並支援匯入印刷廠提供的自訂 `.icc`／`.icm` 描述檔（解析 ICC v2／v4 lut8／lut16／mAB／mBA／matrix-TRC 與 `gamt`）。
- **ICC Profile 嵌入匯出**：匯出 PNG（`iCCP`）、JPEG（`APP2`）與 PSD（影像資源）時可勾選嵌入 RGB ICC 描述檔（預設標準 sRGB IEC61966-2.1，或使用者匯入之 RGB 描述檔）。
- **雙向 Krita `.kra` 匯出**：新增標準 `.kra` 封裝匯出（STORE 無壓縮 `mimetype`、`maindoc.xml`、`mergedimage.png`、`preview.png`、`VERSION 2` 64×64 Planar BGRA + LZF 瓦片流、`.pixelselection` 透明度蒙版），保留群組階層、27 種混合模式、繼承 Alpha 剪裁、透明鎖定、背景色與 DPI；流光匯出後再拖回開啟可達零像素誤差往返。

---

## 三、相容性說明

1. **`.lumina` 專案向下相容**：
   - 維持 `LUMINA_SCHEMA_VERSION = 1`（`appVersion` 記為 `1.4.0`）。既有 `v1.0.x`～`v1.3.x` 儲存的 `.lumina` 檔案、舊版純字串 `LayerTextMeta` 與舊版多人房間資料皆可正常讀取與編輯。
   - 含有 Phase 6 調整圖層的新 `.lumina` 專案若以舊版軟體開啟，該調整層會被辨識為未知圖層類型而略過像素渲染，其餘圖層不受影響。
2. **`.kra`／`.psd`／`.ora` 跨軟體匯出與互通**：
   - **`.kra`**：相容 Krita 原生開啟與流光雙向往返；流光額外寫入 `lumina-opacity` 與 `lumina-maskinverted` 屬性（Krita 會自動忽略）以確保往返時精度與蒙版反轉不遺失。
   - **`.psd`**：保留圖層結構、混合模式、不透明度、蒙版與常見調整層對應，支援嵌入 RGB ICC Profile。
   - **`.ora`**：維持標準 OpenRaster `stack.xml` 與無損 PNG 圖層封裝。
3. **純本機檢視與輔助功能（多人房間零干擾）**：
   - **CMYK 軟校樣與超色域警告**僅套用於本機視口（viewport）顯示濾鏡，不影響 `LayerManager` 內部合成（吸管取色、油漆桶填色、縮圖、匯出像素）且不送出任何多人同步封包。
   - **子視圖（Sub View）**、**色彩歷史**與**迷你混色盤**皆保存於本機 IndexedDB／`localStorage`，不會佔用多人房間頻寬或干擾其他畫友。

---

## 四、已知限制

- **CMYK 軟校樣與匯出**：內建三組印刷條件為依公開目標值估算的近似印刷模型（不內附受授權限制的官方 ICC 檔案），如需商業印前精準校樣請匯入印刷廠提供之 `.icc`／`.icm`；匯出僅嵌入 RGB 描述檔，尚未支援匯出 CMYK 分色 PSD／TIFF。
- **`.kra` 與調整圖層互通**：流光的非破壞性調整圖層目前不轉換為 Krita 濾鏡圖層寫入 `.kra`（視覺結果已烘焙於 `mergedimage.png`）；Krita 的 `inheritsalpha` 會套用至同群組下方全部圖層，若群組內存在多個剪裁基底，在 Krita 中的顯示可能與流光略有差異。
- **調整圖層與 `.psd` 細節**：分享預覽卡片略過群組範圍內的調整圖層；剪裁與群組範圍內若成員使用非一般混合模式為近似結果；超過 16.7 MP 畫布的剪裁／群組調整快取紋理會自動降解析度以保流暢；`.psd` 依色域分段的 HSL、雜訊漸層、鉛筆曲線與其餘 PS 專屬調整類型僅做部分轉換或提示。
- **自動動作與文字細節**：圖層面板手動調整屬性維持不寫入復原堆疊（僅動作播放時納入單步交易）；濾鏡「套用到新圖層」與一般貼上不錄製；插件濾鏡步驟依賴目標環境已安裝該插件；同行混合字級基線採近似下移算法；字型下拉名稱沿用既有標籤。
- **行動端既有介面**：375 px 窄螢幕下匯出視窗的既有標題欄可能以省略號截斷（屬既有樣式行為，不影響功能與操作）。

---

## 五、v1.4.0 發布前驗證紀錄

> 以下皆為本次 `v1.4.0` 收尾階段於最終程式碼上實際執行並觀察到之結果（全部 Electron 測試皆採獨立暫存 `APPDATA`、`LOCALAPPDATA`、`--user-data-dir` 與 `PORT=0`，全程未影響 Port 3000）。

| 驗證項目 | 實際驗證結果 |
| :--- | :--- |
| 全工作區建置（`pnpm -r build`） | **PASS**（`shared`、`server`、`client` 皆退出碼 0） |
| Electron 主程式與內嵌伺服端建置（`pnpm --filter @atelier/client build:electron`） | **PASS**（退出碼 0） |
| 伺服端完整測試（`pnpm --filter @atelier/server test`） | **PASS**（18 階段全數通過，含 Phase 18 調整圖層） |
| 前端邏輯自檢（`ui-logic.check.ts`） | **PASS**（涵蓋核心邏輯與 Phase 6／7／8 全套驗證區段） |
| 四語系覆蓋率檢查（`i18n-coverage.check.ts`） | **PASS**（`zh-TW`、`zh-CN`、`en-US`、`ja-JP` 各 **2,212** 鍵完全對齊） |
| `phase2-subtools-electron-smoke.check.cjs` | **PASS**（11.5s，單機＋`PORT=0` 多人） |
| `phase3-tools-electron-smoke.check.cjs` | **PASS**（11.9s，單機＋`PORT=0` 多人） |
| `phase4-panels-electron-smoke.check.cjs` | **PASS**（14.4s，單機＋`PORT=0` 多人） |
| `phase5-tools-electron-smoke.check.cjs` | **PASS**（19.7s，單機＋`PORT=0` 雙人） |
| `phase6-adjustment-electron-smoke.check.cjs` | **PASS**（18.4s，修正 Phase 8 新增 `/KRA` 匯出選單標籤選取器後單機＋`PORT=0` 雙人全過） |
| `phase7-actions-text-electron-smoke.check.cjs` | **PASS**（19.1s，單機＋`PORT=0` 雙人） |
| `phase8-color-kra-electron-smoke.check.cjs` | **PASS**（25.9s，單機＋`PORT=0` 雙人，15 層 `.kra` 往返最大像素差 0） |
| 版本號一致性檢查 | **PASS**（4 份 `package.json` 皆為 `1.4.0`，說明中心 `[data-testid="app-version-badge"]` 實測顯示 `v1.4.0`） |
| 本機 Krita 5.2.6 `.kra` 相容性實測 | **PASS**（以 Krita 5.2.6 原生 `--export` 成功解析並渲染流光匯出的 15 層 `lumina-exported-v140.kra`，exit=0；目視比對全部色塊、混合模式、蒙版與背景色正常；群組剪裁依 Krita 既有群組範圍 `inheritsalpha` 呈現） |
| 日文／英文多解析度介面防裁切（`1440×900`／`1024×768`／`375×812`） | **PASS**（說明中心、色彩校樣設定、匯出視窗與調整圖層視窗動畫定位後皆無超出視窗邊界與按鈕裁切） |
| 手機單機大畫布效能抽測（`375×812`，`2400×2400` 離線畫布） | **PASS**（畫布建立 970 ms、JS Heap 35.6 MB；45 步連續筆劃 RAF avg 17.16 ms / p95 16.8 ms；60 幀平移 avg 16.68 ms / p95 17.0 ms / max 17.0 ms；0 頁錯） |

---

## 六、v1.4.0 全平台發佈產物（GitHub Release）

GitHub Release [`v1.4.0`](https://github.com/starfireqwq/lumina-drift/releases/tag/v1.4.0)（commit `233965a`）共包含 6 份全平台產物，均已完成上傳與驗證。

| 平台 | 檔名 | 檔案大小 |
| :--- | :--- | :--- |
| Windows（安裝版） | `Lumina-Drift-Paint-Setup-1.4.0.exe` | `132.85 MB` |
| Windows（免安裝版） | `Lumina-Drift-Paint-Portable-1.4.0.exe` | `121.47 MB` |
| macOS（Apple Silicon） | `Lumina-Drift-Paint-Mac-1.4.0-arm64.pkg` | `140.36 MB` |
| macOS（Intel） | `Lumina-Drift-Paint-Mac-1.4.0-x64.pkg` | `148.13 MB` |
| Android | `Lumina-Drift-Paint-Android-1.4.0.apk` | `2.33 MB` |
| Web 靜態包 | `Lumina-Drift-Paint-Web-1.4.0.zip` | `4.75 MB` |

