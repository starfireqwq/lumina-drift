# Lumina Drift 插件開發指南（API v1 / v2）

在畫布上方選擇 **插件 → 管理插件…** 即可匯入 `.lumina-plugin` 檔案，或直接下載內建原創示範：

- **API v2 流光示範套件**：[lumina-drift-studio-kit.lumina-plugin](../apps/client/public/plugins/lumina-drift-studio-kit.lumina-plugin)（涵蓋分塊濾鏡、選區描邊指令、像素與圖層寫入及宣告式面板）
- **API v1 基礎範例**：[studio-tools.lumina-plugin](../apps/client/public/plugins/studio-tools.lumina-plugin)

匯入後請檢視權限清單，按下 **安裝插件** 並在需要時手動 **啟用**。同 `id` 覆蓋更新時會自動恢復「停用」狀態，確保每次更新都能重新審核權限。安裝狀態儲存在本機瀏覽器／App，與畫布及繪茶伺服器分開。

---

## 安全模型與資源上限

所有插件均執行於獨立的 **QuickJS WASM** Web Worker 沙盒內，沒有 DOM、瀏覽器全域物件、檔案系統、網路存取或帳號憑證，亦不依賴 `SharedArrayBuffer`。

| 項目 | 限制 |
| --- | --- |
| 單一檔案大小 | v1：`128 KiB`；v2：`256 KiB` |
| 裝置安裝上限 | `24` 個插件 |
| 記憶體 / 堆疊上限 | 桌面 `32 MiB`、行動／觸控 `24 MiB`；堆疊 `512 KiB` |
| 指令 CPU / 牆鐘上限 | 累計 CPU `3,000 ms`（不含等待 GPU 讀取）；牆鐘總計 `15,000 ms`（超過 `300 ms` 顯示流光條與「中止」按鈕） |
| 濾鏡 CPU 上限 | 單塊 `256×256` tile `500 ms`；預覽總計 `3,000 ms`；套用總計 `15,000 ms`（獨立 Worker，閒置 `60 s` 自動釋放） |
| 單次執行配額 | 最多 `256` 次 RPC、累計讀寫像素 `64 MiB`、單次讀寫區塊至多 `512×512` px、最多建立 `20` 個圖層 |

### 協作與權限鐵律（ACL）
- 所有圖層與像素寫入均受房間權限守門（`layer-acl.ts`）：訪客（Guest）與瀏覽者（Viewer）不可寫入；鎖定圖層與他人私人圖層一律拒絕。
- 插件**禁止**修改圖層所有權或安全屬性（不可執行 `claim`、`release`、`transfer`、更改 `isLocked` / `aclMode` / `isPublic`）。
- 一次指令或面板動作中的所有圖層、像素與選區變更皆包覆在同一交易中：成功時以單一 `groupId` 寫入歷史（單次 `Ctrl+Z` 完整還原），中途失敗則全部回滾不汙染畫布。

---

## API v2 Manifest 規格

`.lumina-plugin` 為 UTF-8 JSON 檔案：

```json
{
  "apiVersion": 2,
  "id": "my-studio.drift-kit",
  "name": "Drift Kit",
  "version": "1.0.0",
  "author": "My Studio",
  "description": "Custom filter, command, and tool panel.",
  "i18n": {
    "zh-TW": { "name": "流光工具包", "description": "自訂濾鏡、指令與面板。" }
  },
  "permissions": ["layers:read", "layers:write", "pixels:read", "pixels:write", "selection", "filters", "commands", "ui:panel"],
  "commands": [],
  "filters": [],
  "panels": [],
  "script": "/* onCommand / onFilter / onPanelAction */"
}
```

### 細粒度權限（v2）

| 權限代碼 | 授權範圍 |
| --- | --- |
| `layers:read` | `api.canvas`、`api.layers.list / get / getActive`、面板 `layer` 欄位 |
| `layers:write` | `api.layers.create / update / reorder / delete / setActive` |
| `pixels:read` | `api.pixels.read / readComposite / getNonEmptyBounds` |
| `pixels:write` | `api.pixels.write` |
| `selection` | `api.selection.*`，以及在 `api.pixels.write` 中顯式設 `respectSelection: false` |
| `filters` | 註冊 `manifest.filters` 並於獨立濾鏡 Worker 執行 `onFilter` |
| `commands` | 註冊 `manifest.commands` 與建議快捷鍵並執行 `onCommand` |
| `ui:panel` | 註冊 `manifest.panels` 宣告式 `ToolWindow` 面板並執行 `onPanelAction` |
| `brush` | （選用）`api.brush.get / set` |

---

## API v2 執行介面

### 1. 指令與面板共用的 `api` 物件

在 `script` 中宣告非同步函式：
- `async function onCommand(commandId, api)` → 可回傳 `{ notice? }`
- `async function onPanelAction(panelId, actionId, values, api)` → 可回傳 `{ patchValues?, statusText?, notice? }`

可用方法：
- `api.canvas`：`{ width, height, dpi, tileSize }`
- `api.brush`：`get()`、`set({ color?, size? })`
- `api.layers`：
  - `list()`、`get(layerId)`、`getActive()`
  - `create({ name, layerType?, blendMode?, opacity?, parentId?, aboveLayerId? })`
  - `update(layerId, { name?, opacity?, blendMode?, isVisible?, alphaLocked?, clipToBelow? })`
  - `reorder(layerId, { parentId?, index? })`
  - `delete(layerId)`、`setActive(layerId)`
- `api.pixels`（所有進出像素皆為 **straight RGBA** `Uint8Array`，系統自動處理 premultiplied 轉換）：
  - `getNonEmptyBounds(layerId)` → `{ x, y, width, height } | null`
  - `read(layerId, { x, y, width, height })` → `{ x, y, width, height, data: Uint8Array }`
  - `readComposite({ x, y, width, height, includeBackground? })` → `{ x, y, width, height, data: Uint8Array }`
  - `write(layerId, { x, y, width, height, data, respectSelection? })`
    - 預設 `respectSelection: true`（受畫布選區遮罩約束）；僅同時持有 `selection` 權限時可設為 `false`。
- `api.selection`：
  - `getInfo()` → `{ hasSelection, bounds }`
  - `readMask({ x, y, width, height })` → `{ x, y, width, height, data: Uint8Array }`
  - `writeMask({ x, y, width, height, data, mode? })`（`mode`: `'replace' | 'add' | 'subtract'`）
  - `selectRect(rect, mode?)`、`selectEllipse(rect, mode?)`、`selectPolygon(points, mode?)`（3..4096 點）
  - `expand(radius)`、`contract(radius)`、`feather(radius)`（1..128 px）
  - `invert()`、`clear()`

### 2. 自訂濾鏡（`manifest.filters` + `onFilter`）

- 每個插件最多宣告 `12` 個濾鏡，每個濾鏡最多 `16` 個參數（支援 `range`、`select`、`toggle`、`color` 與 `when` 條件顯示）。
- `group` 建議設為 `'plugin'`（顯示於專屬「插件」分組，無啟用插件濾鏡時自動隱藏）；也可指定歸屬既有分類（`'color'`、`'effect'`、`'blur'`、`'distort'`、`'sharpen'`、`'render'`、`'lineart'`），於選單項目右側自動顯示小拼圖標記。
- 實作同步函式 `onFilter(filterId, tile, params)`：
  - `tile`：`{ x, y, width, height, padLeft, padTop, padRight, padBottom, canvasWidth, canvasHeight, rgba, selection? }`
  - `rgba` 為包含四邊 `tilePadding`（0..32 px，邊界以 clamp 補齊）的 straight RGBA `Uint8Array`。可直接修改 `tile.rgba` 或回傳等長 `Uint8Array`，宿主只寫回核心區並自動套用選區遮罩、草稿降採樣預覽（`draft: true`）、套用到新圖層與個人收藏。

### 3. 選單指令與防劫持快捷鍵（`manifest.commands`）

- 每個插件最多宣告 `16` 個指令，支援 `i18nLabel`、`group`（自動在「插件」選單插入分隔線）與 `suggestedShortcut`（如 `Alt+Shift+KeyG`）。
- 快捷鍵採命名空間隔離（`plugin:<pluginId>:cmd:<commandId>` / `plugin:<pluginId>:panel:<panelId>`），可在 **設定 → 快捷鍵 → 插件** 自由修改或清除。
- **防劫持規則**：`suggestedShortcut` 若命中瀏覽器保留鍵或與任何內建／已占用快捷鍵衝突，首次啟用時會自動降級為未綁定，絕不覆蓋使用者的內建快捷鍵。

### 4. 宣告式工具面板（`manifest.panels` + `onPanelAction`）

- 每個插件最多宣告 `4` 個面板、每面板最多 `24` 個欄位與 `8` 個動作按鈕，桌面端以浮動 `ToolWindow` 呈現並記憶位置，手機端自動切為底部抽屜。
- 支援 9 種欄位：`section`、`text`、`range`、`number`、`toggle`、`select`、`color`、`layer`（自動同步畫布圖層與唯讀標記）、`input`（限 200 字），支援 `when: { key, is }` 與 `live: true`（200 ms 防抖觸發 `actionId = 'change'`）。

---

## API v1 向後相容規格

`apiVersion: 1` 插件維持 100% 相容：

- 上限：`128 KiB`、最多 `12` 個指令。
- 權限：`brush`、`layers`、`artwork`。
- 腳本宣告同步函式 `run(command, canvas)`，回傳單一操作：`{ kind: 'message', text }`、`{ kind: 'brush', color?, size? }`、`{ kind: 'layer', name }` 或 `{ kind: 'artwork', name, width, height, shapes }`。
