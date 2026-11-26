# Lumina Drift（流光）功能演進與專業化分階段實作藍圖（Phase 1 ～ Phase 8）

> **文件用途**：作為跨聊天室接續開發的唯一事實來源（Single Source of Truth）。每次切換聊天室開始或結束一個 Phase 時，請更新本文件的「總覽進度表」與對應 Phase 的核取方塊（`- [x]`）及交接紀錄，確保不會遺漏任何需求與已驗證的脈絡。
>
> **基準版本**：`v1.3.1`（commit `3018eee`）
> **適用專案**：`C:\Users\KHUser\Downloads\lumina-drift-open-source`
> **明確排除項目**：本藍圖**不包含**「3D 基礎幾何／3D 人偶參考」功能（依專案方向刻意略過，請勿自行加回）。

---

## 一、總覽進度表（跨聊天室追蹤）

| 階段 | 主題 | 對應版本目標 | 建議執行模式 | 狀態 | 最後更新 / Commit |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Phase 1** | v1.3.2 緊急修補、Phase 6 測試修復與發布收尾 | `v1.3.2` | 單聊天室 | `已完成` | 2026-11-26 / 9b8e713 (v1.3.2) |
| **Phase 2** | CSP 風格「主工具列 → 輔助工具組（Sub Tool）」核心架構與填充組整合（含間隙填充筆） | `v1.4.0-alpha.1` | `/teamwork` 或 `/swarm` | `已完成` | 2026-11-26 / `9481f97` |
| **Phase 3** | 選取、向量、混色、漫畫工具組整合與矩形／橢圓／多邊形選框補齊 | `v1.4.0-alpha.2` | `/teamwork` 或 `/swarm` | `已完成` | 2026-11-26 / `4e90e4a` |
| **Phase 4** | 子視圖面板（Sub View）、色彩歷史／混色盤與桌面右鍵快顯輪盤（Pop-up Palette） | `v1.4.0-beta.1` | `/teamwork` | `已完成` | 2026-11-26 / `0129f04` |
| **Phase 5** | 快速形狀（QuickShape）、操控變形（Puppet Warp）與四方連續平鋪（Wrap-Around） | `v1.4.0` | `/teamwork` 或 `/swarm` | `已完成` | 2026-11-26 / `7b3351b` |
| **Phase 6** | 非破壞性調整圖層（Adjustment / Correction Layers）完整管線 | `v1.5.0-alpha` | `/teamwork` 或 `/swarm` | `已完成` | 2026-11-26 / `4b402b8` |
| **Phase 7** | 自動動作／巨集錄製（Auto Actions）與文字排版引擎深化 | `v1.5.0-beta` | `/teamwork` | `已完成` | 2026-11-26 / `4296304` |
| **Phase 8** | 商業印刷色彩管理（CMYK 軟校樣 / ICC）與雙向 `.kra` 匯出 | `v1.5.0` | 單聊天室 或 `/teamwork` | `未開始` | — |

---

## 二、共通開發與驗證紀律（所有 Phase 皆須遵守）

1. **遵守 [AGENTS.md](../AGENTS.md)**：先定位再讀取（單次最多 150 行，禁止整份讀取大型檔案）、禁止任何會丟棄工作樹的 git 指令、嚴格保護 Port 3000 常駐伺服器、PowerShell 禁止使用 `&&`。
2. **隔離 Electron 實測**：每次桌面端自動化測試必須使用獨立的 `APPDATA`、`LOCALAPPDATA` 與 `--user-data-dir`，以及 `PORT=0` 的臨時伺服器，絕不可影響本機日常環境。
3. **四語系同步**：所有新增 UI 文字必須同步補齊 `zh-TW`、`zh-CN`、`en-US`、`ja-JP`（`apps/client/src/locales/`）。
4. **多人與單機一致性**：所有畫布／圖層／工具狀態變更須確認離線單機（`offlineStore.ts`）與多人房間（Socket + Server ACL）行為一致；純本機檢視／輔助功能（如 Sub View、軟校樣預覽）則明確保持本地端不干擾房間其他畫友。
5. **跨聊天室交接**：每個 Phase 完成後，必須在本文件勾選完成項目、填寫實際驗證結果與 commit hash，並產出下一輪切換聊天室的 Prompt。

---

## 三、分階段詳細規劃

### Phase 1：v1.3.2 緊急修補、測試修復與發布收尾
> **建議執行模式**：單聊天室（改動集中在 4～5 個檔案，最快最穩）
> **目標**：徹底修復 v1.3.1 實測抓出的兩個單機高風險 Bug 與一個伺服端測試過期問題，讓核心基礎 100% 穩固後再展開工具列大重構。

#### 任務清單
- [x] **1.1 修復單機匯入 `.lumina` / `.psd` / `.kra` 誤刪第 1 張匯入根圖層**
  - `apps/client/src/services/offlineStore.ts`（`createCanvas`）：回傳 `{ canvas, layers: [...layers] }` 淺拷貝，避免 `record.layers` 原陣列參考外洩給呼叫端的 `defaults`。
  - `apps/client/src/engine/LuminaProjectEngine.ts`（`restoreToCanvas`）：取得 `defaults` 後立即快照 `defaultIds`，避免後續 `createLayer` 影響清理清單；補齊單機匯入回歸單元測試。
- [x] **1.2 修復單機非連續圖層編組與移入群組時相對上下順序反轉**
  - `apps/client/src/components/CanvasWorkspace.tsx`（`groupLayers`）與 `apps/client/src/components/LayerPanel.tsx`（`moveLayersToGroup`）：在逐筆呼叫 `onUpdateLayerProps` 前即先以原始圖層順序計算最終 `ascendingIds`（或以保持原疊層順序的方式套用），避免與 `offlineStore.ts` 每次更新即執行 `tidyLayerModels` 產生交錯翻轉。
  - 確認單機與多人模式結果一致，並補上回歸測試。
- [x] **1.3 修復伺服端 Phase 6 測試逾時（恢復 17/17 全過）**
  - `apps/server/tests/test-phase6-voice-stickers-brushes.ts`：讓 `socketAlice` 改以已認證帳號（帶 JWT token）連線測試貼圖新增／更新／刪除同步，並額外驗證匿名訪客新增貼圖確實收到 `PERMISSION_DENIED`。
- [x] **1.4 核對 KRA `inheritsalpha="1"` 轉 `clipToBelow` 行為**
  - 檢查 `apps/client/src/engine/ExternalProjectImporter.ts` 對 KRA `inheritsalpha` 的轉換與 `LuminaProjectEngine.restoreToCanvas` 寫入流程，修正上輪多人 KRA 實測觀察到 `clip=false` 的問題並補單元測試。
- [x] **1.5 文件與發布收尾（與使用者確認後執行）**
  - 補寫 `docs/CHANGELOG-v1.3.0-to-v1.3.2.md` 並更新 `README.md` 補列 `.psd` / `.kra` 匯入能力。已同步新增 `docs/CHANGELOG.md`。
  - 經使用者確認後決定是否發布 `v1.3.2` 與清理 GitHub 上舊的 `v1.2.8-beta` 預發布 Release。

#### 驗收標準
- 前端單元測試全過（`>= 95/95` + 新增回歸測試）。
- 伺服端 `pnpm --filter @atelier/server test` 達成 **17 / 17 全數通過**。
- 隔離式 Electron 實測：單機與多人拖曳 `.psd` / `.kra` 皆保留全部 4 層（含最底根圖層與剪裁標記）、非連續編組維持原本上下順序且收合展開正常、Shift+拖曳多選正常。

#### 交接紀錄
- 狀態：`已完成`
- 完成 Commit：`92acac2`（1.1 單機匯入保留根圖層）、`abfb6d9`（1.2 非連續圖層編組順序）、`5112367`（1.3 Phase 6 Room ACL 測試）、`a4f8276`（1.4 KRA `inheritsalpha`）、`5df2f94`（1.5 CHANGELOG 與 README）、`9b8e713`（`v1.3.2` 升版與標籤）
- 備註：2026-11-26 正式發布 [`v1.3.2`](https://github.com/starfireqwq/lumina-drift/releases/tag/v1.3.2)。GitHub Actions `macOS packages`（run `45661221325`）雙架構成功，全平台 6 份產物齊備（Setup/Portable `.exe`、Mac `arm64`/`x64` `.pkg`、Android `.apk`、Web `.zip`）。已清理過時的 `v1.2.8-beta` 預發布，保留 `v1.3.0`、`v1.3.1`、`v1.3.2`。驗證成果：前端 105/105、伺服端 17/17、隔離式 Electron 單機與多人 E2E 全過。

---

### Phase 2：CSP 風格「主工具列 → 輔助工具組（Sub Tool）」核心架構與填充組整合
> **建議執行模式**：`/teamwork` 或 `/swarm`（同時跨資料模型、工具列 UI、填充引擎演算法、四語系與測試）
> **目標**：解決左側工具列 27 個扁平按鈕過多、套索填色藏在上方選項列、油漆桶與自動／智能填充分散的問題；建立如 Clip Studio Paint 般的雙層「主工具分類 → 輔助工具組（Sub Tool）」架構，並完整落地「填充」工具組與全新「間隙填充筆」。

#### 任務清單
- [x] **2.1 建立「主工具分類（Tool Category）→ 輔助工具組（Sub Tool）」資料模型與狀態持久化**
  - 在 `apps/client/src/components/workspace/toolCatalog.tsx`（及獨立 `subToolStore.ts`）定義主分類與對應子工具清單。
  - 每個主分類記憶「上次使用的子工具」；每個子工具記憶獨立參數預設（容差、參照層、消除鋸齒、筆刷尺寸、擴張像素等）並持久化至 `localStorage`。
  - 支援快捷鍵行為：按下主分類快捷鍵切回該分類上次子工具；在已啟用狀態下重複按同一快捷鍵可循環切換該分類內子工具（CSP 肌肉記憶）。
- [x] **2.2 精簡左側 `ToolRail` 並整合「工具組（Sub Tool）」選擇面板**
  - 左側 `ToolRail.tsx` 改為精簡的 ~10–11 個主分類圖示（可保留「經典展開模式」切換選項降低老用戶適應門檻）。
  - 筆刷／工具集面板（`BrushToolset.tsx` 或統一的 `SubToolPanel.tsx`）隨左側選中的主分類自動切換顯示對應的「工具組」清單（例如點選「填充」主圖示時，右側／側邊直接出現完整的填充工具組列表；點選「筆刷」時維持現有筆刷組與預覽體驗）。
  - 同步適配平板／手機端浮動工具島（`TouchCanvasChrome.tsx`）。
- [x] **2.3 完整整合「填充（Fill）」工具組（對齊 CSP 截圖）**
  1. **油漆桶 — 參照其他圖層**：`bucket` 模式，預設 `bucketReference = 'all'`。
  2. **油漆桶 — 僅參照編輯圖層**：`bucket` 模式，預設 `bucketReference = 'current'`（亦支援指定參照層）。
  3. **圍住塗抹（Close and Fill）**：整合原本獨立的 `smart_fill`（`computeSmartEncloseFillMask`），可直接在填充工具組中點選。
  4. **套索塗抹（Lasso Fill）**：將原本藏在 `ToolOptionsBar.tsx` 的 `bucketMode = 'lasso'` 提升為獨立子工具，可在填充工具組（及自訂筆刷／工具集）中直接選擇與記憶參數（消除鋸齒、色彩外框、填色／透明擦除）。
  5. **間隙填充筆（Paint Unfilled Area，新增）**：在 `useFillTools.ts` 與共享演算法層實作「依參照圖層／編輯圖層線稿邊界，僅填滿筆刷經過處的未填色封閉微縫且不溢出線外」的演算法（支援擴張縮張像素與閉合間隙設定），並支援單步 Ctrl+Z 與多人 Tile 同步。
- [x] **2.4 清理重複選項與補齊四語系**
  - `ToolOptionsBar.tsx` 依當前啟用的 Sub Tool 顯示精簡對應選項，移除多餘重複的「填色模式」二層切換。
  - 補齊 `zh-TW` / `zh-CN` / `en-US` / `ja-JP` 翻譯。

#### 驗收標準
- 新增單元測試涵蓋：主分類／子工具切換與記憶、重複快捷鍵循環、`間隙填充筆` 像素遮罩不溢出邊界與透明區域補縫精準度。
- 隔離式 Electron 實測：點擊左側「填充」主按鈕即在工具組面板看見全部 5 個填充子工具並可無縫切換作畫；單機與多人畫布皆正確提交與復原。

#### 交接紀錄
- 狀態：`已完成`
- 完成 Commit：`bd3dc70`（2.1 主分類／子工具資料模型與持久化）、`62883a4`（2.3 填充工具組 5 子工具與間隙填充筆演算法）、`8339649`（2.2/2.4 精簡 ToolRail、SubToolPanel、TouchCanvasChrome 與選項列清理）、`9481f97`（2.4 四語系翻譯與 Phase 2 單元／Electron 實測）
- 備註：2026-11-26 完成全套驗證：`pnpm --filter @atelier/shared build`、`pnpm --filter @atelier/client build`、`pnpm --filter @atelier/client build:electron`、`ui-logic.check.ts`、`i18n-coverage.check.ts`（4 語系 1,874 鍵完全一致）、`pnpm --filter @atelier/server test`（17/17 全數通過），以及隔離式 Electron 單機與多人 `PORT=0` 實測腳本 `apps/client/scripts/phase2-subtools-electron-smoke.check.cjs` 全過（實測驗證 11 主分類、5 個填充子工具、`G` 鍵循環、精簡／經典切換、間隙填充筆 5,625 像素零溢出填色、單步 `Ctrl+Z` 與多人 Tile 廣播同步）。

---

### Phase 3：選取、向量、混色、漫畫工具組整合與幾何選框補齊
> **建議執行模式**：`/teamwork` 或 `/swarm`
> **目標**：把剩餘的所有工具全面收斂進 Phase 2 建立的「主工具 → 輔助工具組」體系，補齊主流軟體必備的幾何選框工具，讓左側主工具列徹底清爽一致。

#### 任務清單
- [x] **3.1 「選取（Selection）」工具組整合與新選框補齊**
  - 整合現有：`套索選取`、`魔術棒`、`選取筆`、`選取橡皮擦`。
  - **新增子工具**：
    - `矩形選框（Rect Marquee）`（支援 Shift 正方形、Alt 中心展開）
    - `橢圓選框（Ellipse Marquee）`（支援 Shift 正圓、Alt 中心展開）
    - `多邊形套索（Polygonal Lasso）`（逐點連線、雙擊或 Enter 閉合、Backspace 退回上一點、Esc 取消）
  - 統一支援選取模式（取代／加選 Shift／減選 Alt 或 Ctrl）、消除鋸齒與羽化半徑。
- [x] **3.2 「向量（Vector）」工具組整合**
  - 將 6 顆獨立按鈕（`向量筆`、`貝茲鋼筆`、`節點編輯`、`捏線`、`線寬修正`、`向量橡皮擦`）收斂為單一「向量」主分類＋6 個子工具，並記憶各子工具參數（含向量橡皮擦三模式：擦至交點／局部擦除／整條刪除、線寬修正模式、貝茲模式與筆刷尺寸）。
- [x] **3.3 「混色修整」、「形狀／文字／漫畫」、「變形」工具組收斂**
  - 混色修整組：`揉色`、`模糊`、`液化`（含獨立參數記憶）。
  - 圖形與漫畫組：`形狀`、`文字`、`對話氣泡`、`漫畫分格`（並保留 `動畫` 入口及舊版 `shape` 狀態遷移至 `comic`）。
  - 檢視與輔助組：`抓手`、`滴管`、`漸層`（依常用度保留高頻直達按鈕）；同步適配平板／手機端 `TouchCanvasChrome.tsx`。
- [x] **3.4 快捷鍵面板與外掛工具整合**
  - 更新 `ShortcutManager.ts` 與設定視窗快捷鍵頁，清楚區分「主工具分類快捷鍵（11 項）」與「個別子工具快捷鍵（20 項）」，83 組非空預設快捷鍵零衝突。
  - 確認 Plugin API v2.5 註冊的自訂外掛工具於精簡／經典工具列正常顯示並可切換。

#### 驗收標準
- 新增單元測試：矩形／橢圓／多邊形選框遮罩生成、加選／減選布林運算、Shift 等比與 Alt 中心展開、向量局部擦除、各分類參數持久化與快捷鍵無衝突檢查。
- 隔離式 Electron 實測：左側主工具列無溢出擁擠感；選取、向量、混色、漫畫各主分類切換子工具與快捷鍵循環皆正常，四語系無缺字。

#### 交接紀錄
- 狀態：`已完成`
- 完成 Commit：`ddf8c2b`（3.1 幾何選框與選取工具組 7 子工具）、`6884175`（3.2 向量橡皮擦局部擦除與 6 子工具參數記憶）、`e0dc6d4`（3.3 混色／圖形與漫畫／變形工具組收斂與觸控端適配）、`6d853de`（3.4 主分類 vs 子工具快捷鍵拆分、外掛工具相容確認與四語系補齊）、`4e90e4a`（Phase 3 單元測試與隔離式 Electron 實測腳本）
- 備註：2026-11-26 完成全套驗證：`pnpm --filter @atelier/shared build`、`pnpm --filter @atelier/client build`、`pnpm --filter @atelier/client build:electron`、`ui-logic.check.ts`、`i18n-coverage.check.ts`（4 語系 1,889 鍵完全一致）、`pnpm --filter @atelier/server test` 全數通過；隔離式 Electron 單機與 `PORT=0` 多人實測腳本 `apps/client/scripts/phase3-tools-electron-smoke.check.cjs` 全過（驗證左側 11 主分類零溢出 `scroll=747 <= client=747`、矩形／橢圓／多邊形選框加減選與 Shift/Alt/Backspace/Enter/Esc、向量／混色／漫畫子工具切換與 `V`/`R`/`U`/`L`/`Shift+M`/`W` 快捷鍵、設定視窗 11 主分類 + 20 子工具快捷鍵分區、以及 Plugin API v2.5 `lumina.motion-atelier:starlight-ribbon` 於精簡／經典雙模式工具列相容）。

---

### Phase 4：繪師高頻輔助面板（子視圖 Sub View、歷史色票／混色盤、桌面快顯輪盤）
> **建議執行模式**：`/teamwork`
> **目標**：補齊從 CSP / Krita / Procreate 轉移而來的繪師最常想念的三大日常效率面板，大幅減少視線與游標在畫布與面板間來回奔波的距離。

#### 任務清單
- [x] **4.1 獨立「子視圖 / 參考圖面板（CSP Sub View）」**
  - 新增可停靠於 Dock 系統（`DockSystem.tsx` / `dockStore.ts`）或浮動的 `SubViewPanel.tsx`（含 `subViewMath.ts`、`subViewStore.ts`、`Ctrl+Shift+R` 快捷鍵）。
  - 支援本機多圖載入（拖曳、選檔、剪貼簿貼上）、圖片切換箭頭、獨立縮放／平移／水平翻轉／旋轉，以及「游標移入自動切換吸色滴管」直接取色至主畫布前景色。
  - 資料僅存於本機（IndexedDB `lumina_subview_v1` + 記憶體回退），不佔用多人房間頻寬。
- [x] **4.2 色彩歷史紀錄（Color History）與調色混色盤（Mixing Pad）**
  - 在 `ColorWheelStudio.tsx` 擴充「最近使用顏色」自動歷史列（隨落筆／填色／形狀／向量／吸色去重記錄並持久化至本機，支援固定常用色票組與匯入／匯出 `.aco` v1+v2 / `.gpl`）。
  - 新增可選分頁「迷你混色盤（Mixing Pad）」（`ColorMixingPad.tsx` + `mixingPadEngine.ts`）：一塊輕量本機混色畫布，支援上色／揉色混色／清除／重設預設色點與即時吸取回主畫布前景色。
- [x] **4.3 桌面端快顯輪盤（Krita Pop-up Palette）**
  - 延伸現有 `TouchRadialMenu.tsx` 概念，新增桌面端 `DesktopPopupPalette.tsx`（含 `popupPaletteMath.ts` 邊界防裁切定位），透過滑鼠右鍵／數位筆側鍵／自訂快捷鍵（預設 `Alt+Q`）於游標位置喚出「中央 HSV 色環＋內環最近色票＋外環常用筆刷與常用子工具」三層環形輪盤，支援長按鬆開或點選即關閉。
  - 於設定視窗一般設定提供開關與觸發方式自訂（`right-click` / `pen-side-button` / `shortcut-only`），避免與現有右鍵選單衝突。

#### 驗收標準
- 單元測試：色票歷史去重與持久化、`.gpl`/`.aco` 色票解析與匯出、混色畫布像素演算法、Sub View 座標與吸色換算、快顯輪盤邊界防裁切定位與觸發規則。
- 隔離式 Electron 實測：Sub View 載圖縮放翻轉吸色正常、色彩歷史隨落筆自動更新與混色盤調色吸色正常、桌面右鍵／快捷鍵喚出 Pop-up Palette 換筆刷與換色流暢，且本機資料不佔多人房間頻寬。

#### 交接紀錄
- 狀態：`已完成`
- 完成 Commit：`521f8c5`（4.1 獨立子視圖 Sub View 面板、座標／吸色演算法與本機 IndexedDB 多圖儲存）、`7c1e4de`（4.2 色彩歷史去重持久化、`.aco`/`.gpl` 匯入匯出、固定色票組與迷你混色盤 Mixing Pad）、`4d3a843`（4.3 桌面端快顯輪盤 Pop-up Palette、觸發設定、`Ctrl+Shift+R`/`Alt+Q` 快捷鍵與四語系補齊）、`0129f04`（Phase 4 單元測試與隔離式 Electron 實測腳本）
- 備註：2026-11-26 完成全套驗證：`ui-logic.check.ts`、`i18n-coverage.check.ts`（4 語系 1,952 鍵完全一致、85 組預設快捷鍵零衝突）、`pnpm --filter @atelier/shared build`、`pnpm --filter @atelier/client build`、`pnpm --filter @atelier/client build:electron`、`pnpm --filter @atelier/server test` 全數通過；隔離式 Electron 單機與 `PORT=0` 多人實測腳本 `apps/client/scripts/phase4-panels-electron-smoke.check.cjs` 全過（驗證 Sub View `Ctrl+Shift+R` 開啟、多圖切換、縮放／翻轉反轉吸色／旋轉／重設與 IndexedDB 重載保留、落筆自動記錄 `#D946EF`、固定色票、`.gpl` 匯入與 Mixing Pad 塗抹揉色吸取 `#F29C0C`、桌面快顯輪盤四角防裁切定位／換色／換橡皮擦與筆刷預設／`shortcut-only` 觸發隔離，以及 `PORT=0` 臨時多人房 0 筆房間 op 外洩與 0 頁錯）。

---

### Phase 5：快速形狀（QuickShape）、操控變形（Puppet Warp）與四方連續平鋪（Wrap-Around）
> **建議執行模式**：`/teamwork` 或 `/swarm`（三個功能各自核心演算法獨立，非常適合並行開發再整合）
> **目標**：補齊 Procreate、CSP 4.0 / PS、Krita 三大招牌創作利器，強化速寫、修形與無縫材質創作體驗。

#### 任務清單
- [x] **5.1 Procreate 風格快速形狀（QuickShape）**
  - 在 `StrokePipeline.ts` / `useBrushTool.ts` 加入收筆停頓偵測（可於設定自訂延遲 ms 與開關）。
  - 依筆劃幾何特徵自動辨識並吸附為：直線、圓弧、圓形／橢圓、矩形／四邊形、三角形；按住不放拖曳可即時調整角度／半徑／端點，支援單步復原。
- [x] **5.2 操控變形（Puppet Warp）**
  - 新增 `PuppetWarpEngine.ts` 與 `PuppetWarpOverlay.tsx`（入口整合進變形選單／工具組）。
  - 自動針對圖層非透明輪廓（或選區）建立三角網格（Delaunay / 均勻網格裁剪），支援點擊新增／刪除釘點（Pin）、拖曳釘點與旋轉權重，採 ARAP（As-Rigid-As-Possible）或加權剛性變形減少扭曲失真，預覽流暢、確認後一次性寫入 Tile 並同步多人房間。
- [x] **5.3 四方連續平鋪模式（Wrap-Around Seamless Mode）**
  - 新增檢視與繪製開關（快捷鍵 `Alt+W`，避開既有魔術棒 `W`／向量線寬 `Shift+W`，並整合至檢視列按鈕與視窗選單），在 `Viewport` / `CanvasWorkspace` 以 3×3 無縫重複顯示畫布。
  - 筆刷、橡皮擦、揉色、模糊、油漆桶與形狀工具在平鋪模式啟用時自動對座標與髒瓦片進行 Modulo 環繞繪製，讓跨邊界筆劃自動接合，單機與多人畫布同步正確。

#### 驗收標準
- 單元測試：QuickShape 幾何擬合準確率（直線／圓／橢圓／矩形）、Puppet Warp 網格生成與形變不產生 NaN／黑邊、Wrap-Around 跨邊界 Tile 座標環繞計算。
- 隔離式 Electron 實測：三項功能皆可流暢互動、Ctrl+Z 完整還原，且多人連線時第二位畫友正確看到變形與跨邊界繪製結果。

#### 交接紀錄
- 狀態：`已完成`
- 完成 Commit：`23bc416`（5.1 Procreate 風格快速形狀 QuickShape 幾何引擎、設定持久化、停筆吸附拖曳與多人預覽協定）、`186d347`（5.2 ARAP 操控變形 `PuppetWarpEngine.ts` / `PuppetWarpOverlay.tsx`、變形工具列整合與 `Ctrl+Alt+P` 快捷鍵）、`abcd974`（5.3 四方連續平鋪 `wrapAround.ts`、3×3 即時檢視、跨邊界環繞工具繪製與零衝突 `Alt+W` 快捷鍵）、`7b3351b`（Phase 5 單元測試、四語系覆蓋率強化與隔離式單機／雙人 Electron 實測腳本）
- 備註：2026-11-26 完成全套驗證：`ui-logic.check.ts`（含 QuickShape 7 種形狀＋負向測試／調整／設定、Puppet Warp 網格／ARAP／分離島／零黑邊預乘雙線性光柵化、Wrap-Around Modulo 瓦片／環形填色與 94 組預設快捷鍵零衝突）、`i18n-coverage.check.ts`（4 語系 1,985 鍵全對齊）、`pnpm --filter @atelier/shared build`、`pnpm --filter @atelier/client build`、`pnpm --filter @atelier/client build:electron`、`pnpm --filter @atelier/server test`（17 階段全過）；隔離式 Electron 單機與 `PORT=0` 雙人實測腳本 `apps/client/scripts/phase5-tools-electron-smoke.check.cjs` 全數通過（驗證 QuickShape 設定／直線拖曳調整／圓形吸附／單步 `Ctrl+Z`、Puppet Warp `Ctrl+Alt+P`／2 釘點拖曳＋旋轉權重／確認與 `Ctrl+Z`、Wrap-Around `Alt+W`／跨邊界筆劃與 `Ctrl+Z`，以及雙獨立 Electron 畫友連線時畫友 B 即時收到 1,720 px Puppet Warp 變形與左右各 696 px Wrap-Around 跨邊界筆劃及復原同步，全程 0 頁錯）。

---

### Phase 6：非破壞性調整圖層（Adjustment / Correction Layers）完整落地
> **建議執行模式**：`/teamwork` 或 `/swarm`（跨 `packages/shared`、Pixi/WebGL 合成管線、`LayerPanel`、伺服端儲存、`.lumina` / `.psd` 讀寫）
> **目標**：正式啟用 `LayerType = 'adjustment'`，提供如 PS / CSP / Krita 般的即時非破壞性調色工作流。

#### 任務清單
- [x] **6.1 共享型別與前後端持久化支援**
  - 擴充 `packages/shared/src/types/models.ts` 的 `LayerMeta.adjustment` 結構（種類與參數 DTO）：
    - `hsl`（色相／飽和度／明度）
    - `levels`（色階：輸入黑／灰／白、輸出上下限）
    - `curves`（RGB 與單通道色調曲線控制點）
    - `color_balance`（陰影／中間調／亮部色彩平衡）
    - `gradient_map`（漸層對應色標）
    - `brightness_contrast`（亮度／對比）
  - 確認 `offlineStore.ts`、伺服端 SQLite `layers.meta`、`LuminaProjectEngine`（`.lumina` 存讀檔）皆完整保留與同步調整圖層參數。
- [x] **6.2 即時合成渲染管線（`LayerManager.ts` / `layerComposite.ts` / `ExportEngine.ts`）**
  - 在即時畫布合成與離線匯出合成中，對下層已合成結果套用調整圖層效果；完整支援：
    - 調整圖層本身的不透明度與混合模式
    - 搭配剪裁遮色片（`clipToBelow`，只影響正下方基底圖層）
    - 搭配圖層蒙版（局部遮罩控制調色範圍）
    - 群組內作用範圍隔離（避免影響群組外圖層）
- [x] **6.3 UI 與互動體驗**
  - 在 `LayerPanel.tsx` 與上方選單新增「新增調整圖層」入口、專屬圖示與雙擊編輯參數視窗（即時預覽、不改動原像素、單步復原）。
  - 評估與 `.psd` 匯入／匯出的相容對應（至少針對常見調整層保留名稱與基本轉換或提示）。

#### 驗收標準
- 單元測試：6 種調整圖層像素運算結果、剪裁遮色片限定範圍、圖層蒙版局部遮罩、`.lumina` 打包還原一致性。
- 隔離式 Electron 實測：建立調整圖層後仍可自由修改下層線稿／底色並即時反映調色，雙擊調整圖層可隨時改參數，匯出 PNG／PSD 畫面與畫布所見完全一致，多人房間同步調整參數無誤。

#### 交接紀錄
- 狀態：`已完成`
- 完成 Commit：`03cb9ea`（6.1 shared 調整圖層模型、正規化、6 種像素運算、作用範圍解析與 GLSL）、`599f843`（6.1 伺服端／離線／`.lumina`／時光膠囊持久化、驗證與像素寫入防護，伺服端第 18 階段測試）、`480a5d9`（6.2 CPU 匯出合成：根層／剪裁／群組範圍、蒙版與不透明度，分享預覽）、`56e1988`（6.3 `.psd` 調整圖層讀寫 `psdAdjustmentMapping.ts`）、`1284678`（6.2 `LayerManager` 即時合成 `AdjustmentFilter`、範圍紋理快取與預覽 API）、`0dbb1f8`（6.3 調整參數視窗、建立／單步復原流程與像素工具防護）、`f27ecbe`（6.3 圖層面板入口、種類圖示、上方「圖層」選單與說明中心）、`4b402b8`（Phase 6 隔離式單機／雙人 Electron 實測腳本）
- 合成規則（實作與匯出一致）：調整圖層對其位置以下的已合成畫面生效，係數 = 有效不透明度 × 自身蒙版 × 群組蒙版；勾選「剪裁到下方」時只作用於剪裁群組（基底＋其間被剪裁圖層），位於群組內時只作用於同群組、位於其下的圖層（以範圍單獨合成後的差值加回，與 Photoshop 正常群組／剪裁群組在一般混合下一致）；未剪裁的調整圖層作為剪裁基底時視為「白色 × 自身蒙版」。即時畫面用 `blendRequired` 濾鏡（`blendMode = none`、`resolution = inherit`），剪裁／群組範圍用依相依指紋快取的畫布空間紋理（超過 16.7 MP 會降解析度）。
- 備註：2026-11-26 完成全套驗證：`pnpm --filter @atelier/shared build`、`pnpm --filter @atelier/client build`、`pnpm --filter @atelier/client build:electron`、`pnpm --filter @atelier/server test`（18 階段全過，含新增第 18 階段調整圖層 REST／Socket／像素寫入防護）、`ui-logic.check.ts`（新增 7 個 Phase 6 區段：6 種像素運算與正規化、持久化、匯出合成、PSD 對應與 ag-psd 真實位元組往返、即時檢視快取、編輯流程、選單與說明）、`i18n-coverage.check.ts`（4 語系 2,037 鍵全對齊）；隔離式 Electron 實測 `apps/client/scripts/phase6-adjustment-electron-smoke.check.cjs` 全數通過（單機：HSL 即時預覽且底層位元組不變、調整圖層下方筆刷即時反映、雙擊改參數＋單步 `Ctrl+Z`／重做、剪裁曲線保留紙色、蒙版局部、群組隔離、匯出 PNG 與即時畫面最大差 0；`PORT=0` 雙人：畫友 B 即時收到建立、改參數與復原，全程 0 頁錯）。另以臨時 GPU 健全性腳本確認螢幕與合成讀回在根層／剪裁／50% 不透明度／群組範圍下皆與 CPU 公式一致。
- 已知限制：分享預覽卡片略過群組範圍的調整圖層（近似效果）；剪裁與群組範圍在成員使用非一般混合模式時為近似；`.psd` 依色域分段的色相／飽和度、雜訊漸層、鉛筆曲線與其他 PS 調整類型只做提示或部分轉換；Codex 額度中途用盡時 6.2／PSD 由主代理接手實作。

---

### Phase 7：自動動作／巨集（Auto Actions）與文字排版引擎深化
> **建議執行模式**：`/teamwork`
> **目標**：為高產插畫／漫畫創作者提供批次自動化流程（CSP / PS Auto Actions），同時將文字工具升級至可應付商業嵌字與封面排版的水準（對齊 Krita 5.3 / CSP）。

#### 任務清單
- [x] **7.1 自動動作／巨集系統（Auto Actions）**
  - 建立 `ActionRecorder.ts` 與 `AutoActionsPanel.tsx`（可停靠於 Dock）。
  - 支援錄製、暫停、編輯步驟清單、重新排序、單步停用與一鍵播放：涵蓋新增／複製／合併／刪除圖層、切換混合模式與不透明度、套用濾鏡、建立調整圖層、選區擴張／反轉／清除、線稿抽色等高頻指令。
  - 整個動作播放包裹於單一 `groupId` 交易中（一次 Ctrl+Z 完整撤銷）；支援匯入／匯出 `.lumina-action` JSON 分享給社群。
  - 內建 5～8 個實用預設動作（如「線稿自動發光氛圍」、「一鍵建立陰影剪裁層」、「角色貼紙白邊外框」、「色差濾鏡後製」）。
- [x] **7.2 文字排版引擎深化**
  - 擴充 `LayerTextMeta`（向後相容既有純字串欄位）支援：
    - 富文本區段（局部文字改色、字級、粗體／斜體）
    - 字距（Tracking / Letter-spacing）與行距精調
    - 文字對齊（靠左／置中／靠右）與固定文字方塊自動換行（`textBoxRect`）
    - 描邊置後（Paint Order：Stroke behind Fill，避免粗外框吃掉筆畫）與陰影效果
    - 直排（縱書）與漫畫標點避頭尾／括號旋轉進一步優化
  - 升級 `TextCanvasEditor.tsx` 畫布上即時編輯體驗。

#### 驗收標準
- 單元測試：動作錄製與序列化還原、單步復原交易包裹、富文本區段排版與直排換行邊界測試、舊版 `LayerTextMeta` 向下相容測試。
- 隔離式 Electron 實測：實際錄製「複製層 → 高斯模糊 → 濾色 40%」動作並對另一圖層重播且可一次 Ctrl+Z 復原；文字層支援局部改色、描邊置後與存檔重開可再編輯。

#### 交接紀錄
- 狀態：`已完成`
- 完成 Commit：`ad9bf0f`（7.1 `ActionRecorder.ts`：12 種步驟、錄製／暫停／合併連續滑桿、步驟編輯、`.lumina-action` 匯入匯出防護、7 個內建動作、單一 `groupId` 播放與失敗回滾；`ScopedUndoManager` 群組擷取；shared `ScopedUndoOp.propsBefore/propsAfter`）、`c58c880`（7.2 shared `LayerTextMeta` 富文本欄位與 `text-meta.ts`、`textLayer.ts` 純版面計算／方塊換行／避頭尾／直排括號旋轉與小寫假名、描邊置後／置前與陰影渲染）、`7710ebf`（7.2 `TextCanvasEditor.tsx` 局部樣式、字距行距、對齊、可拖曳換行方塊、描邊順序與陰影、版面一致的游標與選取、說明中心）、`9ab54da`（7.1 `autoActionHost.ts` 畫布整合、錄製掛鉤、`LAYER_PROPS` 屬性復原、播放期間鎖輸入、`AutoActionsPanel.tsx` Dock／手機 sheet、四語系與說明主題）、`4296304`（Phase 7 自檢接入 `ui-logic.check.ts` 與隔離式 Electron 實測腳本）
- 設計重點：播放時 `ScopedUndoManager.beginGroup` 讓期間推入的所有 op（建立／刪除圖層、濾鏡 tile、屬性、選區）共用同一個 `groupId`，一次 Ctrl+Z／Ctrl+Y 撤銷或重做整段；任一步失敗即撤銷該群組並從 redo 移除。複製步驟不覆蓋使用者的圖層剪貼簿。錄製只掛在使用者入口（Ctrl+J／選單複製、新增點陣圖層、合併、刪除、混合模式／不透明度／剪裁、就地套用濾鏡、建立與修改調整圖層、選區反轉／擴張收縮／取消），播放時自動抑制錄製。文字新欄位全為選填，舊資料與舊房間照舊顯示；伺服端 meta 仍為 JSON 直通（32KB 上限），不需改伺服端。
- 備註：2026-11-26 完成全套驗證：`pnpm --filter @atelier/shared build`、`pnpm --filter @atelier/client build`、`pnpm --filter @atelier/client build:electron`、`pnpm --filter @atelier/server test`（18 階段全過）、`ui-logic.check.ts`（新增 5 個 Phase 7 區段：動作錄製與 `.lumina-action` 序列化還原、36 步以上長動作單步復原交易包裹、host 錯誤代碼與屬性復原、面板標籤與 Dock 遷移、富文本與直排換行邊界、舊版 `LayerTextMeta` 相容、編輯器狀態）、`i18n-coverage.check.ts`（4 語系 2,164 鍵全對齊）；隔離式 Electron 實測 `apps/client/scripts/phase7-actions-text-electron-smoke.check.cjs` 第一輪即全數通過（單機：從實際 UI 錄製「複製層 → 高斯模糊 10 → 濾色 40%」恰為 4 步、對另一圖層重播產生正上方 Screen 40% 光暈層且來源像素不變、一次 Ctrl+Z／重做／Ctrl+Z 整段往返、內建陰影剪裁層一次復原、匯入含未知步驟的 `.lumina-action` 略過 1 步、文字局部改紅＋白色描邊、描邊置前紅色像素減少且復原誤差 ≤2%、同一 user-data-dir 重開後文字樣式可再編輯；`PORT=0` 雙人：畫友 B 收到重播的 Screen 40% 圖層、一次復原與相同文字樣式段，全程 0 頁錯）。另以內建瀏覽器檢視日文介面 1440×900 與 375×812：面板與文字工具列（含「更多」popover）皆無裁切。
- 已知限制：使用者在圖層面板手動改屬性仍不進復原堆疊（維持原習慣，只有動作播放會記錄）；濾鏡「套用到新圖層」與一般貼上不錄製；插件濾鏡步驟依賴該插件已安裝；同行混合字級的基線為近似值（下移 (最大字級 − 字級) × 0.8）；字型下拉的名稱（黑體／明體等）沿用既有中文標籤；Codex 沙箱無 pnpm 且需暫時 preload 處理 `uv_os_get_passwd`，所有驗證均由主代理以 pnpm／tsx 重跑。

---

### Phase 8：商業印刷色彩管理（CMYK 軟校樣 / ICC）與雙向 `.kra` 匯出
> **建議執行模式**：單聊天室 或 `/teamwork`
> **目標**：打通商業出版與同人誌印刷最後一哩路，並完成與 Krita 的雙向無損專案互通。

#### 任務清單
- [ ] **8.1 CMYK 軟校樣（Soft Proofing）與色域警告**
  - 實作輕量 ICC Profile 解析與 3D LUT（RGB ↔ CMYK 近似／精準轉換）檢視濾鏡，可在「檢視 → 色彩校樣」一鍵開關軟校樣預覽（如 sRGB → Japan Color 2001 Coated / FOGRA39 / US Web Coated SWOP）。
  - 提供「超色域警告（Gamut Warning）」高亮疊層，讓繪師在作畫期間即時察覺螢光色印刷溢色區域。
  - 支援使用者自訂匯入本機 `.icc` / `.icm` 描述檔，並於匯出 PNG / JPEG / PSD 時選擇嵌入 ICC Profile。
- [ ] **8.2 雙向 `.kra` 匯出（Export `.kra`）**
  - 在 `ExportEngine.ts` 與 `kraEncoder.ts`（對應現有 `kraDecoder.ts`）實作 Krita 專案打包：
    - 產出標準 `mimetype`（STORE 無壓縮）、`maindoc.xml`、`mergedimage.png`、`preview.png`
    - 產出各圖層與透明度蒙版的 `VERSION 2` 64×64 Planar BGRA + LZF 壓縮瓦片流
    - 完整保留圖層樹群組、混合模式反向映射、不透明度、`inheritsalpha` 剪裁與透明鎖定
  - 於 `ExportModal.tsx` 加入 `.kra` 匯出選項與四語系說明。

#### 驗收標準
- 單元測試：`.kra` 匯出 → `kraDecoder.ts` / `ExternalProjectImporter.ts` 完整 Round-Trip 驗證（圖層樹、混合模式、像素誤差為 0）；ICC / CMYK 軟校樣轉換與色域警告判定測試。
- 隔離式 Electron 實測：開啟軟校樣與色域警告無明顯掉幀；匯出 `.kra` 後直接再拖回流光開啟，圖層結構、群組、混合模式與畫面像素完全一致。

#### 交接紀錄
- 狀態：`未開始`
- 完成 Commit：`待填`
- 備註：`—`
