# Lumina Drift（流光）v1.3.0 → v1.3.2 完整更新總結

> **比較基準**　`v1.3.0`（`fe807fb`，2026-11-24）→ `v1.3.1`（`3018eee`，2026-11-24）→ `v1.3.2`（2026-11-26）

---

## 一、版本演進總覽

| 版本 | 日期 | 更新重點 |
| :--- | :--- | :--- |
| `v1.3.0` | 2026-11-24 | 本次比較的基準版本，涵蓋觸控手勢、筆刷、動畫、濾鏡、外掛與多人協作升級。 |
| `v1.3.1` | 2026-11-24 | 新增 PSD／KRA 匯入，改善非連續圖層編組與圖層面板多選。 |
| `v1.3.2` | 2026-11-26 | 修復單機匯入與圖層順序、Krita 剪裁遮色片轉換，以及 Phase 6 的貼圖同步測試。 |

---

## 二、v1.3.1 功能與操作改進

### 1. Adobe Photoshop 與 Krita 多圖層匯入（`c33c8cb`）

- 支援 Adobe Photoshop（`.psd`）與 Krita（`.kra`），保留圖層樹與巢狀群組、混合模式、不透明度、顯示狀態、剪裁遮色片、透明鎖定，以及圖層／群組蒙版。
- 可將專案檔案拖曳至視窗直接開啟，也可用檔案選單或 `Ctrl+O` 選取檔案。單機工作區與多人聯機協作工作區皆可匯入。

### 2. 非連續圖層編組整理（`f7e84d1`）

- 使用 `tidyLayerModels` 依圖層樹整理堆疊，讓原本分散的選取圖層編組後連續排列在新群組下方。圖層面板依群組階層顯示圖層，收合新群組時會一併隱藏其子圖層。

### 3. 按住 Shift 拖曳連續多選（`f7e84d1`）

- 在圖層面板按住 `Shift + 左鍵拖曳` 掃過多列，即可連續選取起點到目前位置之間的圖層。拖到清單上、下緣時會自動捲動。使用 `Ctrl+Shift` 拖曳可在既有選取上加選。

---

## 三、v1.3.2 Hotfix 詳解

### 1. 單機匯入保留第一張根圖層（`92acac2`）

- `offlineStore.createCanvas` 曾直接回傳內部圖層陣列。還原 `.lumina`、`.psd` 或 `.kra` 專案時，匯入流程在新增圖層的同時也改動了這份陣列，清理預設圖層時因此可能誤刪第一張匯入的根圖層。
- `offlineStore.ts` 回傳圖層快照。`LuminaProjectEngine.ts` 在開始還原前記下預設圖層 ID，並在清理時跳過已匯入的 ID。新增 `offline-restore.test.mts` 涵蓋預設圖層清理與匯入根圖層保留。

### 2. 單機編組與批次移入維持相對上下順序（`abfb6d9`）

- `groupLayers` 與 `moveLayersToGroup` 逐層更新父群組時，`tidyLayerModels` 會在搬移尚未完成時重新整理圖層樹，可能使非連續的來源圖層在目的群組中上下反轉。
- `layer-tree.ts` 提供排序計算，讓 `CanvasWorkspace.tsx` 依移動前的堆疊規劃新群組的最終順序，並讓 `LayerPanel.tsx` 依各來源圖層與目標群組的相對位置安排移入順序。`layer-groups.test.mts` 補齊編組與批次移入的回歸案例。

### 3. Phase 6 貼圖同步與房間權限測試（`5112367`）

- `test-phase6-voice-stickers-brushes.ts` 使用帶有 JWT 的已認證帳號連線，驗證貼圖新增、更新與刪除會同步給房間內的其他用戶端，避免測試因寫入權限不足而等待同步逾時。
- 補上房間存取控制（Room ACL）的拒絕案例，驗證匿名訪客嘗試寫入貼圖會收到 `PERMISSION_DENIED`。

### 4. Krita Alpha 繼承轉為剪裁遮色片（`a4f8276`）

- `kraDecoder.ts` 讀取 Krita `.kra` 的 `inheritsalpha`，並相容 `inheritalpha` 與 `inheritAlpha`。`ExternalProjectImporter.ts` 將值為 `"1"` 的 Alpha 繼承旗標轉成 `clipToBelow`，讓匯入圖層保留剪裁遮色片設定。
- `external-project-import.test.mts` 補上 Krita Alpha 繼承屬性的回歸案例。

---

## 四、v1.3.2 驗證紀錄

下表沿用 v1.3.2 提供的發佈驗證紀錄。

| 驗證項目 | 發佈驗證結果 |
| :--- | :--- |
| 前端單元測試 | **105/105** 通過。 |
| 伺服端測試 | **17/17** 通過。 |
| 隔離式 Electron 單機 E2E | 全數通過。 |
| 隔離式 Electron 多人 E2E | 全數通過。 |

---

## 五、v1.3.2 預期全平台發佈產物

| 平台 | 預期檔名 | 狀態 |
| :--- | :--- | :--- |
| Windows（安裝版） | `Lumina-Drift-Paint-Setup-1.3.2.exe` | 待發佈 |
| Windows（免安裝版） | `Lumina-Drift-Paint-Portable-1.3.2.exe` | 待發佈 |
| macOS（Apple Silicon） | `Lumina-Drift-Paint-Mac-1.3.2-arm64.pkg` | 待發佈 |
| macOS（Intel） | `Lumina-Drift-Paint-Mac-1.3.2-x64.pkg` | 待發佈 |
| Android | `Lumina-Drift-Paint-Android-1.3.2.apk` | 待發佈 |
| Web 靜態包 | `Lumina-Drift-Paint-Web-1.3.2.zip` | 待發佈 |
