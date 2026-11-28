# Lumina Drift Paint v1.5.0 Release Notes（四語系正式發佈說明）

> 完整跨版本更新紀錄（`v1.3.0` → `v1.5.0`）請參閱 [CHANGELOG-v1.3.0-to-v1.5.0.md](./CHANGELOG-v1.3.0-to-v1.5.0.md)。

---

## 繁體中文

### Lumina Drift Paint v1.5.0 正式版

> **範圍說明**：依專案規劃方向，本版本**不包含**「3D 基礎幾何／3D 人偶參考」功能。

#### 核心新功能

- **圖層色標、草稿染色與「用紙」底色系統**
  - 支援 8 色圖層／群組面板色標、非破壞性草稿染色（主色／副色即時切換）與「用紙（Paper）」底色切換及多人房間同步。
- **尺規系統 v2（純 2D）**
  - 新增集中線／放射狀尺規、曲線／貝茲特殊尺規、圖層綁定尺規（全部圖層／同資料夾／目標圖層），以及純 2D 1/2/3 點透視空間網格（`xy`／`xz`／`yz` 三平面獨立開關與可拖曳基準點）。
- **可伸縮懸浮圖標小球與膠囊 Dock**
  - 任一浮動面板皆可縮成高辨識度圖標小球，多個小球可磁吸合併為橫／直向膠囊 Dock，並支援點擊展開切換與拖出拆球。
- **筆刷引擎 v3 與跨軟體筆刷格式支援**
  - 新增雙筆刷（Dual Brush）、色彩動態、水彩濕邊、減色顏料混色與多筆尖輪播。
  - 深度強化 Clip Studio Paint（`.sut`）與 Procreate（`.brushset`）筆刷匯入參數還原，並新增 Adobe Photoshop（`.abr` v6.2）單筆刷與多筆刷群組匯出。
- **非破壞性圖層樣式、快速遮色片與色域選取**
  - 新增 4 種非破壞性圖層樣式（銳利／水彩邊界、陰影、外發光、色彩覆蓋），完整串接 GPU 預覽、匯出與多人即時同步。
  - 新增快速遮色片（`Q` 鍵切換）、色域選取對話框（即時遮罩預覽／滴管取色／容差與羽化）及單張 WebP 匯出。
- **多人繪茶 2.0**
  - 新增跟隨繪師視角（含平移／縮放／旋轉／鏡像／DPI 同步）、協作接龍分格認領（Grid Slots）、房間共用色票盤與共用參考圖板（具房主／管理員鎖定權限且與個人 Sub View 隔離）。
- **動畫音訊波形與 MP4／WebM 音軌混音匯出**
  - 時間軸新增高 DPI 真實音訊波形顯示、直接拖曳起始幀與行內靜音；支援離線立體聲 PCM 混音與 WebCodecs MP4／WebM 含音軌匯出（不支援時安全降級為純影像）。
- **商業印刷真 CMYK 4 通道分色匯出與 TAC 警告**
  - 支援原生 Baseline TIFF 6.0 與 CMYK ColorMode PSD 真 4 通道分色匯出，內建 GCR／UCR 黑版模型（Japan Color 2001 Coated／FOGRA39／US Web Coated SWOP 與自訂參數）、即時總墨量（TAC）熱點預覽警告與自動限墨。
- **超大畫布（4K～13K）效能與記憶體防護**
  - 導入 Tile GPU LRU 池化與 `TileAtlas` 紋理頁溫熱重用池；大幅加速 13500×7800 50 圖層載入／繪製／復原並修復縮小時 Mipmap 淡化；補齊行動端與多人 13500×7500 OOM／WebGL 紋理上限防護。
- **即時畫布導覽器與字型庫升級**
  - 新增即時畫布導覽器（視口紅框拖曳、垂直翻轉）與本機字型掃描、可搜尋字型選擇器、橫直書快速切換。

#### 介面打磨與實機複測修復

- **工具列與輔助工具集重構**：折疊精簡主工具列獨立顯示文字、漫畫、動畫（共 14 大類）；統一輔助工具集面板、分隔線與精簡說明；整併單一油漆桶並同步上下參照屬性；智能填色整合「圍住塗抹」與「間隙補塗」；新增獨立 5 款橡皮擦工具集（硬邊、軟邊、感壓大小、定寬無感壓、感壓透明）並支援四段消除鋸齒與即時筆觸預覽；淺色主題下筆刷與橡皮擦預覽自動切換為深黑筆觸以維持清晰對比。
- **操作細節與單機模式淨化**：變形工具綁定 `Ctrl+T`；支援 `Shift + 滾輪` 與 `Ctrl／⌘ + Shift + 滾輪` 旋轉畫布，並可於設定中自訂步進角度；單機／離線模式隱藏多人房間專屬的圖層協作控制項；修復調整圖層標題跳動與切換畫布時快速遮色片狀態重置。
- **介面流暢度與六大材質升級**：移除炫彩玻璃導致卡頓掉幀的根因；升級「流光霓虹」雙流波動效果（支援彩色 RGB／單色／雙色、主副色與飽和度微調，低飽和度自然往純白發光過渡並排除相鄰／巢狀雙條重複流光）；全面強化六大介面表面材質質感。
- **大型 PSD 串流匯入與圖層組完整合成**：改以逐層延遲解碼直出 256×256 LZ4 瓦片，修復大型 CSP PSD 開啟時 `Exceeded memory limit` 問題；完整支援圖層組剪裁到下方圖層（含跨群組剪裁與群組基底）、圖層組混合模式（色彩增值／濾色／柔光等）與圖層效果整體套用、整個圖層組設為參考圖層，以及直接選取資料夾整組移動／變形（保留子層結構與整組原子復原）。
- **流暢度、縮圖與視窗停靠體驗升級**：保存／另存專案即時顯示進度並移除重複壓縮卡頓；優化連續縮放 Mipmap 與切回視窗自動預載視口瓦片；圖層縮圖免點擊自動載入並仿 CSP 依畫布長寬比顯示不扭曲；色彩面板切換列移至最近使用色彩下方；修復合併懸浮視窗拖曳並支援左右側停靠面板直接合併為分頁。
- **Windows 安裝精靈優化**：重編 `LuminaGlassUI.dll`，提升暗色流光玻璃背景下的 GroupBox 亮字可讀性。

---

## 简体中文

### Lumina Drift Paint v1.5.0 正式版

> **范围说明**：按项目规划方向，本版本**不包含**“3D 基础几何／3D 人偶参考”功能。

#### 核心新功能

- **图层色标、草稿染色与“纸张”底色系统**
  - 支持 8 色图层／分组面板色标、非破坏性草稿染色（主色／副色实时切换）与“纸张（Paper）”底色切换及多人房间同步。
- **标尺系统 v2（纯 2D）**
  - 新增集中线／放射状标尺、曲线／贝塞尔特殊标尺、图层绑定标尺（全部图层／同文件夹／目标图层），以及纯 2D 1/2/3 点透视空间网格（`xy`／`xz`／`yz` 三平面独立开关与可拖拽基准点）。
- **可伸缩悬浮图标小球与胶囊 Dock**
  - 任意浮动面板均可缩为高辨识度图标小球，多个小球可磁吸合并为横／纵向胶囊 Dock，支持点击展开切换与拖出拆球。
- **笔刷引擎 v3 与跨软件笔刷格式支持**
  - 新增双笔刷（Dual Brush）、色彩动态、水彩湿边、减色颜料混色与多笔尖轮播。
  - 深度强化 Clip Studio Paint（`.sut`）与 Procreate（`.brushset`）笔刷导入参数还原，并新增 Adobe Photoshop（`.abr` v6.2）单笔刷与多笔刷分组导出。
- **非破坏性图层样式、快速蒙版与色域选取**
  - 新增 4 种非破坏性图层样式（锐利／水彩边界、阴影、外发光、色彩叠加），完整串联 GPU 预览、导出与多人实时同步。
  - 新增快速蒙版（`Q` 键切换）、色域选取对话框（实时蒙版预览／吸管取色／容差与羽化）及单张 WebP 导出。
- **多人共绘 2.0**
  - 新增跟随画师视角（含平移／缩放／旋转／镜像／DPI 同步）、协作接龙分格认领（Grid Slots）、房间共享色板与共享参考图板（具备房主／管理员锁定权限且与个人 Sub View 隔离）。
- **动画音频波形与 MP4／WebM 音轨混音导出**
  - 时间轴新增高 DPI 真实音频波形显示、直接拖拽起始帧与行内静音；支持离线立体声 PCM 混音与 WebCodecs MP4／WebM 含音轨导出（不支持时自动安全降级为纯画面）。
- **商业印刷真 CMYK 4 通道分色导出与 TAC 警告**
  - 支持原生 Baseline TIFF 6.0 与 CMYK ColorMode PSD 真 4 通道分色导出，内置 GCR／UCR 黑版模型（Japan Color 2001 Coated／FOGRA39／US Web Coated SWOP 及自定义参数）、实时总墨量（TAC）热点预览警告与自动限墨。
- **超大画布（4K～13K）性能与显存防护**
  - 引入 Tile GPU LRU 池化与 `TileAtlas` 纹理页温热复用池；大幅加速 13500×7800 50 图层加载／绘制／撤销并修复缩小时 Mipmap 淡化；补齐移动端与多人 13500×7500 OOM／WebGL 纹理上限防护。
- **实时画布导航器与字体库升级**
  - 新增实时画布导航器（视口红框拖拽、垂直翻转），以及本地字体扫描、可搜索字体选择器与横竖排快速切换。

#### 界面打磨与实机复测修复

- **工具栏与辅助工具集重构**：折叠精简主工具栏独立显示文字、漫画、动画（共 14 大类）；统一辅助工具集面板、分隔线与精简说明；整合单一油漆桶并同步上下参照属性；智能填色整合“包围涂抹”与“间隙补涂”；新增独立 5 款橡皮擦工具集（硬边、软边、压感大小、定宽无压感、压感透明）并支持四段抗锯齿与实时笔触预览；浅色主题下笔刷与橡皮擦预览自动切换为深黑笔触。
- **操作细节与单机模式净化**：变形工具绑定 `Ctrl+T`；支持 `Shift + 滚轮` 与 `Ctrl／⌘ + Shift + 滚轮` 旋转画布，并可在设置中自定义步进角度；单机／离线模式隐藏多人房间专属的图层协作控件；修复调整图层标题跳动与切换画布时快速蒙版状态重置。
- **界面流畅度与六大材质升级**：移除炫彩玻璃导致卡顿掉帧的根因；升级“流光霓虹”双流波动效果（支持彩色 RGB／单色／双色、主副色与饱和度微调，低饱和度自然向纯白发光过渡并排除相邻／嵌套双条重复流光）；全面强化六大界面表面材质质感。
- **大型 PSD 流式导入与图层组完整合成**：改为逐层延迟解码直出 256×256 LZ4 瓦片，修复大型 CSP PSD 打开报 `Exceeded memory limit` 的问题；完整支持图层组剪贴蒙版（含跨分组与分组基底）、图层组混合模式（正片叠底／滤色／柔光等）与图层效果整体生效、将整个图层组设为参考图层，以及直接选中文件夹整组移动／变形（保留子层结构与整组原子撤销）。
- **流畅度、缩略图与窗口停靠体验升级**：保存／另存项目实时显示进度并消除重复压缩卡顿；优化连续缩放 Mipmap 与切回窗口自动预载视口瓦片；图层缩略图免点击自动加载并按画布比例显示不拉伸；色彩面板模式切换移至最近使用颜色下方；修复合并悬浮窗拖拽并支持左右侧停靠面板合并为标签页。
- **Windows 安装向导优化**：重编 `LuminaGlassUI.dll`，提升暗色流光玻璃背景下的 GroupBox 亮字可读性。

---

## English

### Lumina Drift Paint v1.5.0

> **Scope Note**: By project direction, **3D primitive geometry and 3D figure reference models** are explicitly out of scope and not included in this release.

#### Highlights & New Features

- **Layer Color Tags, Non-Destructive Draft Tinting & Paper Background**
  - Assign 8 panel color tags to layers and folders, toggle non-destructive primary/secondary Draft Tint colors, and switch canvas Paper backgrounds with real-time multiplayer sync.
- **Rulers v2 (Pure 2D)**
  - Added radial/focus-line rulers, curve/Bézier special rulers, layer-scoped rulers (all layers / same folder / target layer), and pure 2D 1/2/3-point perspective grids with independent `xy`/`xz`/`yz` plane toggles and draggable anchors.
- **Collapsible Floating Icon Pills & Capsule Dock**
  - Collapse any floating panel into a compact icon pill and magnetically dock multiple pills into a horizontal or vertical capsule dock with click-to-expand and drag-to-detach support.
- **Brush Engine v3 & Cross-App Brush Format Support**
  - Added Dual Brush texturing, color dynamics, wet edges, subtractive pigment mixing, and multi-tip cycling.
  - Deepened Clip Studio Paint (`.sut`) and Procreate (`.brushset`) brush import fidelity, and added Adobe Photoshop (`.abr` v6.2) single-brush and multi-brush group export.
- **Non-Destructive Layer Effects, Quick Mask & Color Range**
  - Added four non-destructive layer effects (crisp/watercolor border, drop shadow, outer glow, color overlay) across live GPU rendering, exports, and multiplayer sync.
  - Added Quick Mask mode (`Q`), Color Range selection dialog (live mask preview, eyedropper sampling, tolerance & feathering), and single-image WebP export.
- **Multiplayer Collab 2.0**
  - Added Follow Camera (syncing pan, zoom, rotation, flip, and DPI), Grid Slots claiming for relay collabs, Room Swatches, and a Shared Reference Board (with host/admin lock controls, strictly isolated from local Sub View).
- **Animation Audio Waveform Timeline & Mixed-Audio MP4/WebM Export**
  - High-DPI `<canvas>` waveform display with inline mute and drag-to-offset start frames; offline stereo PCM mixing and WebCodecs MP4/WebM audio-track muxing with graceful video-only fallback when unsupported.
- **True 4-Channel CMYK Print Separation (TIFF / PSD) & TAC Warning**
  - Native Baseline TIFF 6.0 and CMYK ColorMode PSD 4-channel export with configurable GCR/UCR black generation (Japan Color 2001 Coated, FOGRA39, US Web Coated SWOP, or custom), live Total Area Coverage (TAC) hotspot preview, and automatic ink limiting.
- **Ultra-Large Canvas (4K–13K) Performance & Memory Safety**
  - Introduced `TileGpuLruPool` and `TileAtlas` warm page reuse; accelerated 13500×7800 50-layer load/draw/undo and fixed zoom-out mipmap fading; added OOM and WebGL texture-size guards for 13500×7500 mobile and multiplayer sessions.
- **Live Canvas Navigator & Font Library Upgrade**
  - Added the live Canvas Navigator panel (draggable viewport red box and vertical flip) along with local font scanning, a searchable font picker, and quick horizontal/vertical text toggling.

#### Refinements & Device Verification Fixes

- **Streamlined Toolbar, Unified Fill & Dedicated 5-Preset Eraser Toolset**: Expanded the compact toolbar to 14 categories so Text, Comic, and Animation are directly accessible; unified Sub Tool panel dividers and concise hints; consolidated Paint Bucket with synchronized top-bar and side-panel reference settings; unified Enclose & Fill and Gap Fill inside Smart Fill; added 5 dedicated Eraser presets (Hard, Soft, Pressure Size, Fixed Size, Pressure Opacity) with 4-level anti-aliasing and live stroke previews; automatically switched brush and eraser previews to dark ink on light themes for high legibility.
- **Controls & Solo-Mode Polish**: Bound Transform to `Ctrl+T`; added `Shift + Wheel` and `Ctrl/⌘ + Shift + Wheel` canvas rotation with customizable step angles in Settings; hid multiplayer-only layer collaboration controls in solo/offline canvases; fixed adjustment-layer header jumping and Quick Mask reset on canvas switches.
- **UI Performance & Six Surface Materials**: Eliminated the CSS stutter root cause in Chromatic Glass; upgraded Lumina Glow with dual-stream wave effects (RGB / Mono / Dual color modes, primary/secondary pickers, luminous white-light transition at low saturation, and deduplicated single-seam light streams); refined all six UI surface materials.
- **Large PSD Streaming Import & Full Layer-Group Semantics**: Switched PSD decoding to layer-by-layer streaming straight into 256×256 LZ4 tiles (fixing `Exceeded memory limit` on huge CSP/Photoshop PSDs); added full support for Clip-to-Below on groups (including clipped group chains and group clip bases), group-wide blend modes (Multiply, Screen, Soft Light, etc.) and layer effects, setting an entire folder as a Reference Layer, and direct Move/Transform on folders with atomic undo.
- **Save Progress, Viewport Responsiveness, Aspect Thumbnails & Docking**: Added live progress toasts and fast PNG `STORE` ZIP packaging for Save / Save As; reduced zoom mipmap hitches and automatically resumed viewport tile hydration on window focus/visibility return; auto-loaded layer panel thumbnails without clicking using CSP-style proportional aspect-ratio frames; moved Color Wheel/Mixing & HSV/HLS toggles below Recent Colors; fixed dragging merged floating windows and enabled tab merging inside Left/Right docks.
- **Windows Installer Polish**: Rebuilt `LuminaGlassUI.dll` with brighter GroupBox text contrast against the dark glass installer background.

---

## 日本語

### Lumina Drift Paint v1.5.0 正式版

> **対象外項目について**：プロジェクト方針により、**「3D プリミティブ幾何形状／3D デッサン人形リファレンス」**は本バージョンの対象外であり、含まれていません。

#### 主な新機能

- **レイヤーカラーラベル・下書き着色・「用紙」背景システム**
  - 8 色のレイヤー／フォルダーカラーラベル、非破壊の下書き着色（メイン／サブ色切替）、「用紙（Paper）」背景色のリアルタイム切替と共同ルーム同期に対応しました。
- **定規システム v2（純 2D）**
  - 集中線／放射定規、曲線／ベジェ特殊定規、レイヤー連動定規（全レイヤー／同一フォルダー／対象レイヤーのみ）、純 2D の 1/2/3 点透視空間グリッド（`xy`／`xz`／`yz` 面の個別切替とドラッグ可能な基準点）を追加しました。
- **折りたたみアイコンボール＆カプセル Dock**
  - フローティングパネルをアイコンボールに縮小し、複数パネルを磁着させて縦横切替可能なカプセル Dock として統合できます（クリック展開・ドラッグ分離対応）。
- **ブラシエンジン v3 と外部ブラシ形式対応**
  - デュアルブラシ、カラーダイナミクス、水彩ウェットエッジ、減法顔料混色、マルチチップ切替を搭載しました。
  - Clip Studio Paint（`.sut`）および Procreate（`.brushset`）ブラシの読み込み再現度を強化し、Adobe Photoshop（`.abr` v6.2）単体／グループ書き出しを新設しました。
- **非破壊レイヤー効果・クイックマスク・色域指定選択**
  - 4 種の非破壊レイヤー効果（フチ／水彩境界、ドロップシャドウ、光彩、カラーオーバーレイ）をリアルタイム GPU 表示・書き出し・共同同期に一貫対応しました。
  - クイックマスク（`Q` キー）、色域指定選択ダイアログ（リアルタイムプレビュー／スポイト取得／許容値・ぼかし）、単一 WebP 書き出しを追加しました。
- **共同お絵描き 2.0**
  - 視点追従（移動・拡大縮小・回転・反転・DPI 同期）、リレー作画向けコマ割り担当（Grid Slots）、ルーム共有スウォッチ、共有資料ボード（ホスト／管理者ロック対応・個人サブビューとは分離）を追加しました。
- **アニメーション音声波形タイムライン＆MP4／WebM 音声ミックス書き出し**
  - 高 DPI `<canvas>` による実波形表示、開始フレームのドラッグ調整、行内ミュートに対応。オフラインステレオ PCM ミックスと WebCodecs による音声付き MP4／WebM 書き出しに対応（非対応環境では安全に映像のみへフォールバック）。
- **商業印刷向け真 CMYK 4 チャンネル分版書き出し＆TAC 警告**
  - Baseline TIFF 6.0 および CMYK ColorMode PSD の 4 チャンネル書き出しに対応。GCR／UCR 黒版設定（Japan Color 2001 Coated／FOGRA39／US Web Coated SWOP・カスタム）、リアルタイム総インキ量（TAC）ヒートマップ警告、自動インキ制限を備えます。
- **超大キャンバス（4K〜13K）性能最適化とメモリ保護**
  - Tile GPU LRU プールと `TileAtlas` ページ再利用を導入。13500×7800・50 レイヤーの読み込み／描画／取り消しを高速化し縮小時の Mipmap 退色を修正。モバイルおよび共同作画での 13500×7500 OOM／WebGL テクスチャ上限保護を実装しました。
- **リアルタイムキャンバスナビゲーター＆フォント機能強化**
  - 表示範囲の赤枠ドラッグと上下反転に対応したキャンバスナビゲーター、ローカルフォントスキャン、検索付きフォントピッカー、縦書き／横書き切替を追加しました。

#### UI 磨き込みと実機検証による修正

- **ツールバー・塗りつぶし・独立消しゴムサブツール群の整備**：コンパクトツールバーを 14 カテゴリへ拡張しテキスト・漫画・アニメーションを直接表示。サブツールセットの区切り線と説明を統一整理し、単一バケツの上下参照設定を同期。スマート塗りに「囲って塗る」と「塗り残し補正」を統合し、4 段階アンチエイリアスとリアルタイムストロークプレビュー対応の 5 種消しゴムサブツール群（硬め・柔らかめ・筆圧サイズ・固定サイズ・筆圧不透明度）を独立搭載しました。ライトテーマではブラシ／消しゴムプレビューを黒インクへ自動切替します。
- **操作性向上とオフライン UI の整理**：変形ツールを `Ctrl+T` に割り当て。`Shift + ホイール`／`Ctrl・⌘ + Shift + ホイール` のキャンバス回転と設定画面での角度カスタマイズを追加。オフライン／ソロ作画時は共同作画専用のレイヤー UI を非表示化し、色調補正レイヤーのヘッダー跳ねやキャンバス切替時のクイックマスク残留を修正しました。
- **描画パフォーマンスと 6 種サーフェス質感の刷新**：クロマチックガラスで発生していたフレーム落ちの根本原因を除去。ルミナグローをデュアルストリーム発光（RGB／単色／2 色・低彩度時の白光発光・重複ストリーム排除）へ強化し、全 6 種の UI サーフェス質感を磨き上げました。
- **大容量 PSD ストリーミング読込＆フォルダー完全対応**：PSD をレイヤー単位で 256×256 LZ4 タイルへ直接デコードし `Exceeded memory limit` を解消。フォルダーへのクリッピング（フォルダー基底含む）、フォルダー全体の合成モード（乗算・スクリーン・ソフトライト等）とレイヤー効果、フォルダー全体の参照レイヤー指定、およびフォルダー単位での直接移動・変形（子レイヤー保持＋一括取り消し）に対応しました。
- **保存進捗・描画応答性・サムネイル・ドッキング改善**：保存／別名保存の進捗表示と高速化（PNG 無再圧縮）、連続ズーム時の Mipmap 負荷軽減とウィンドウ復帰時の自動タイル再読込、クリック不要でキャンバス縦横比を保つ CSP 風レイヤーサムネイル自動表示、カラー切替ボタンの履歴下への配置、統合フローティングウィンドウのドラッグ修正、左右ドック内でのタブ結合を追加しました。
- **Windows インストーラー改善**：`LuminaGlassUI.dll` を再ビルドし、暗色ガラス背景における GroupBox テキストの視認性を向上しました。
