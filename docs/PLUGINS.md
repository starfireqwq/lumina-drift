# Lumina Drift 插件開發指南（API v1 / v2 / v2.5 / v3.0）

在畫布上方選擇 **插件 → 管理插件…** 即可匯入 `.lumina-plugin` 檔案，或直接下載內建原創示範：

- **API v3.0 桌面橋接示範**：[lumina-v3-bridge-demo.lumina-plugin](../apps/client/public/plugins/lumina-v3-bridge-demo.lumina-plugin)（涵蓋受信任本機工具橋接、本機 MCP 狀態查詢，以及於 Web／手機／多人房的安全降級）
- **API v2.5 流光動態工坊**：[lumina-motion-atelier.lumina-plugin](../apps/client/public/plugins/lumina-motion-atelier.lumina-plugin)（涵蓋自訂畫布指標工具、時間軸／關鍵影格／自訂貝茲緩動與筆刷引擎 v2 動態混色預設）
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
| 自訂工具指標保護 | 指標移動節流 `16..200 ms`（預設 `24 ms`，併發合併只送最新點）；單次事件 CPU `500 ms` / 牆鐘 `1,500 ms`；整筆拖曳 CPU `4,000 ms` / 牆鐘 `30,000 ms`（逾時或取消立即終止 Worker 並回滾預覽像素） |
| 單次執行配額 | 最多 `256` 次 RPC、累計讀寫像素 `64 MiB`、單次讀寫區塊至多 `512×512` px、最多建立 `20` 個圖層、每插件最多 `8` 個自訂工具與 `16` 組自訂緩動 |

### 協作與權限鐵律（ACL）
- 所有圖層、像素、時間軸與關鍵影格寫入均受房間權限守門（`layer-acl.ts`）：訪客（Guest）與旁觀者（Viewer）不可寫入；鎖定圖層與他人私人圖層一律拒絕；批次寫入關鍵影格（`keyframes.setBatch`）只要包含任一無權圖層即整批拒絕、零副作用。
- 插件**禁止**修改圖層所有權或安全屬性（不可執行 `claim`、`release`、`transfer`、更改 `isLocked` / `aclMode` / `isPublic`），亦**禁止**透過 `brush.set` 更動防手震（`stabilizerLevel`）。
- 一次指令、面板動作或自訂工具單筆拖曳中的所有圖層、像素、選區、時間軸與關鍵影格變更皆包覆在同一交易中：成功時以單一 `groupId` 寫入歷史（單次 `Ctrl+Z` 完整還原），中途失敗或取消則全部回滾不汙染畫布。

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
| `timeline:read` | （v2.5）`api.timeline.getState / listLabels`、`api.keyframes.list / evaluate`、`api.easing.listPresets / evaluate` |
| `timeline:write` | （v2.5）`api.timeline.setFrame / setFps / setLength / setRange / setLoop / setLabel / removeLabel / updateCel`、`api.keyframes.set / setBatch / remove / clear`、`api.easing.register / unregister` |
| `tools` | （v2.5）註冊 `manifest.tools` 自訂工具至工具列、插件選單與防劫持快捷鍵 |
| `input` | （v2.5）為啟用中的自訂工具接收節流畫布指標事件（`onPointerDown / onPointerMove / onPointerUp / onCancel`） |
| `brush` | （選用）`api.brush.get / set`（支援筆刷引擎 v2 動態與混色參數，不可修改防手震） |

---

## API v2 執行介面

### 1. 指令與面板共用的 `api` 物件

在 `script` 中宣告非同步函式：
- `async function onCommand(commandId, api)` → 可回傳 `{ notice? }`
- `async function onPanelAction(panelId, actionId, values, api)` → 可回傳 `{ patchValues?, statusText?, notice? }`

可用方法：
- `api.canvas`：`{ width, height, dpi, tileSize }`
- `api.brush`：
  - `get()`：讀取現行筆刷狀態，含筆刷引擎 v2 參數（`color`, `secondaryColor`, `size`, `minSize`, `opacity`, `flow`, `hardness`, `spacing`, `scatter`, `roundness`, `tipAngle`, `angleMode`, `tiltSize`, `mixMode`, `colorMixing`, `paintAmount`, `colorStretch`, `fgBgMix`, `wetEdges`, `hueJitter`, `satJitter`, `valJitter`, `textureDensity`, `textureScale`, `textureInvert`, `textureBlendMode`, `dualBrush`, `dualSize`, `dualScatter`, `dualBlendMode`, `dynamics`）。
  - `set(patch)`：套用上述任一合法參數（`dynamics` 各通道自動正規化；傳入 `stabilizerLevel` 會被拒絕）。
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
- `api.timeline`（v2.5）：
  - `getState()` → `{ fps, length, currentFrame, isPlaying, loop, range, tracks }`
  - `setFrame(frame)`、`setFps(fps, folderId?)`（1..60）、`setLength(length | null, folderId?)`、`setRange({ start, end } | null)`、`setLoop(bool)`
  - `listLabels(folderId?)`、`setLabel(frame, text, folderId?)`、`removeLabel(frame, folderId?)`
  - `updateCel(entryId, { hold?, mark?, note? })`（`mark`: `'key' | 'inbetween' | null`）
- `api.keyframes`（v2.5）：
  - `list(layerId)`、`evaluate(layerId, frame?)`
  - `set(layerId, { frame, x?, y?, scaleX?, scaleY?, rotation?, pivotX?, pivotY?, opacity?, easing?, bezier?, presetId? })`
  - `setBatch([{ layerId, keyframes, replace? }])`（或 `setBatch(layerId, keyframes, { replace? })`；具備原子 ACL 檢查，任一無權圖層整批拒絕）
  - `remove(layerId, frame)`、`clear(layerId)`
- `api.easing`（v2.5）：
  - `listPresets()` → 內建與已註冊自訂緩動清單
  - `register(id, [x1, y1, x2, y2], label?)`、`unregister(id)`（`x1, x2 ∈ [0, 1]`，`y1, y2 ∈ [-2, 3]`，插件停用時自動清理）
  - `evaluate(t, { easing?, bezier?, presetId? })` → `{ value }`

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

### 5. 自訂工具與節流畫布指標事件（v2.5：`manifest.tools` + `onPointer*`）

- 需同時宣告 `tools`（於工具列、插件選單與快捷鍵 `plugin:<pluginId>:tool:<toolId>` 註冊）與 `input`（接收畫布指標事件）。
- 每個插件最多宣告 `8` 個工具，每個工具最多 `12` 個選項（支援 `range`、`select`、`toggle`、`color` 與 `when` 條件顯示），顯示於上方工具選項列；可選設 `icon`（`wand | brush | pen | sparkles | stamp | shapes | ruler | crosshair | layers | film`）、`cursor`（`crosshair | pointer | grab | move | cell | default`）與 `throttleMs`（`16..200`，預設 `24`）。
- 在 `script` 中宣告非同步或同步事件處理器（單筆拖曳共享同一個 QuickJS Worker 狀態與同一個交易 `groupId`）：
  - `async function onPointerDown(toolId, event, api)`
  - `async function onPointerMove(toolId, event, api)`（經節流與併發合併，只派送最新指標點，完成後即時預覽像素）
  - `async function onPointerUp(toolId, event, api)` → 可回傳 `{ notice? }`，完成後整筆提交為單步復原
  - `async function onCancel(toolId, event, api)` → 多指手勢、視窗失焦、切換工具或逾時取消時呼叫，並自動回滾全部預覽像素
- `event` 欄位：`{ phase, x, y, startX, startY, deltaX, deltaY, pressure, tiltX, tiltY, pointerType, buttons, shiftKey, ctrlKey, altKey, metaKey, timestamp, options }`。

---

## API v3.0 桌面外部橋接與本機 MCP（僅限桌面版單機）

`apiVersion: 3` 完整向下相容 v2 / v2.5 全部能力，並新增三項高權限能力，**僅在 Electron 桌面版的本機單機畫布開放**；Web 瀏覽器、手機裝置與多人協作房間預設全面封鎖並安全降級（套件中的 v2/v2.5 非 v3 功能仍可照常運作）。

### 新增權限與安全護欄

| 權限代碼 | 能力範圍 | 強制安全邊界 |
| --- | --- | --- |
| `bridge:local` | `api.bridge.listTools()`、`api.bridge.invoke(toolId, payload)` | 插件不可在 manifest 內嵌執行檔路徑或 shell 指令；使用者必須先在 **管理插件 → 桌面橋接與 MCP…** 透過系統檔案視窗綁定受信任執行檔並鎖定 SHA-256；一律以 `shell: false` 在一次性暫存目錄執行、禁止 shell 元字元與 `-` 開頭引數注入、禁止 `..` 路徑遍歷，執行前必彈二次授權視窗。 |
| `mcp:server` | `api.mcp.serverStatus()`（絕不將 Bearer Token 暴露給插件沙盒） | 由桌面主行程管理，僅監聽 `127.0.0.1`（絕不綁 `0.0.0.0`），每次啟動輪換 256-bit Bearer Token（`timingSafeEqual`）、強制驗證 `Host` 與拒絕跨站 `Origin`（防 DNS Rebinding / CSRF）；預設唯讀，勾選允許寫入後仍強制走 `PluginCanvasTransaction`、`layer-acl.ts` 與單步 `Ctrl+Z` 復原，且不可更動防手震。 |
| `mcp:client` | `api.mcp.listServers()`、`api.mcp.listTools(serverId)`、`api.mcp.callTool(serverId, name, args)` | 僅允許使用者在桌面控制台登錄之本機迴路（`127.0.0.1` / `localhost`）端點，拒絕外網與區網 SSRF，每次工具呼叫皆須經二次授權確認。 |

### 本機 MCP 伺服器工具清單與 stdio 轉接

- **唯讀工具（預設啟用）**：`canvas.get_info`、`layers.list`、`pixels.get_bounds`、`pixels.read_region`、`timeline.get_state`、`keyframes.list`。
- **受控寫入工具（需顯式勾選「允許寫入畫布」）**：`layers.create`、`layers.update`、`pixels.fill_rect`、`timeline.set_frame`、`keyframes.set`（每次呼叫皆為單步復原交易，且禁止任何防手震或圖層所有權異動）。
- **零依賴 stdio 轉接腳本**：若外部代理僅支援 stdio，可使用 `apps/client/scripts/mcp-stdio-bridge.mjs` 並設定環境變數 `LUMINA_MCP_URL` 與 `LUMINA_MCP_TOKEN`（同樣拒絕非本機迴路 URL）。
- **隨時中斷（Kill Switch）**：v3 橋接或 MCP 運作期間，畫布底部顯示流光警示列，可隨時一鍵「中止全部橋接」終止全部子行程、關閉 MCP 伺服器並撤銷工作階段授權；切入多人協作房間或覆蓋更新／停用插件亦會自動撤銷與中斷。

---

## API v1 向後相容規格

`apiVersion: 1` 插件維持 100% 相容：

- 上限：`128 KiB`、最多 `12` 個指令。
- 權限：`brush`、`layers`、`artwork`。
- 腳本宣告同步函式 `run(command, canvas)`，回傳單一操作：`{ kind: 'message', text }`、`{ kind: 'brush', color?, size? }`、`{ kind: 'layer', name }` 或 `{ kind: 'artwork', name, width, height, shapes }`。
