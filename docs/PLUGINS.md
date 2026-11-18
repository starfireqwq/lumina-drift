# Lumina Drift 插件 API v1

在畫布上方選擇 **插件 → 管理插件 → 下載範例**，或直接下載 [Studio Tools](../apps/client/public/plugins/studio-tools.lumina-plugin)。匯入檔案後確認權限，按 **安裝插件**，再按 **啟用**。回到 **插件** 選單即可執行指令。安裝狀態儲存在目前的 App 或瀏覽器，與畫布及繪茶伺服器分開。

## 檔案格式

`.lumina-plugin` 是 UTF-8 JSON。可直接編輯範例，或在打包時把 JavaScript 檔內容讀進 `script` 欄位後以 `JSON.stringify` 輸出。

```json
{
  "apiVersion": 1,
  "id": "my-studio.canvas-info",
  "name": "Canvas Info",
  "version": "1.0.0",
  "author": "My Studio",
  "permissions": [],
  "commands": [{ "id": "dimensions", "label": "Show canvas dimensions" }],
  "script": "function run(command, canvas) { return { kind: 'message', text: canvas.width + ' × ' + canvas.height + ' px' }; }"
}
```

| 欄位 | 說明 |
| --- | --- |
| `apiVersion` | 目前為 `1` |
| `id` | 插件的唯一 ID。使用小寫英數字，可用 `.`、`-`、`_` 分段 |
| `name`、`version`、`author` | 顯示在插件管理器 |
| `description` | 選填，描述插件功能 |
| `permissions` | 宣告需要的操作。可用 `brush`、`layers`、`artwork` |
| `commands` | 最多 12 個指令。每項有自己的 `id` 和顯示在選單的 `label` |
| `script` | 單一 JavaScript 原始碼字串，必須宣告同步函式 `run(command, canvas)` |

同 ID 的新檔會取代舊版，並重新停用，讓使用者查看新版權限。不同插件請使用不同 ID。每個安裝檔最多 128 KiB，每個裝置的 App 或網站最多安裝 12 個插件。

## 指令可以做什麼

`canvas` 提供 `width`、`height` 和 `dpi`。每次呼叫回傳一個操作：

| 回傳值 | 所需權限與行為 |
| --- | --- |
| `{ kind: 'message', text }` | 無需額外權限，顯示短訊息 |
| `{ kind: 'brush', color?, size? }` | `brush`。調整目前筆刷、鉛筆或橡皮擦。顏色為 `#RRGGBB`，大小為 1–1000 px |
| `{ kind: 'layer', name }` | `layers`。新增空白點陣圖層 |
| `{ kind: 'artwork', name, width, height, shapes }` | `artwork`。在畫布中央建立並填入新點陣圖層，可使用一般撤銷 |

圖案的 `shapes` 可使用 `rect` 或 `ellipse`，各自有 `kind`、`x`、`y`、`width`、`height`、`color`。座標相對於圖案左上角，橢圓使用外接矩形的座標和尺寸。圖案須符合畫布大小，寬高各至多 4096 px、總面積至多 4,194,304 像素、最多 1,000 個元素。新增圖層仍受目前房間的圖層權限約束。

JavaScript 每次在新的隔離環境執行，沒有瀏覽器物件、檔案系統、網路或登入資訊。API v1 支援單次同步指令、畫布尺寸與上述操作。它尚不提供既有圖層像素讀寫、背景執行、自訂面板或 Krita 的 Python API。
