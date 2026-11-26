/**
 * The help centre's content: short topics, each with the words people might search for.
 * Key labels are never written here: `keys` names ShortcutManager actions, and the help centre
 * shows whatever the user has bound them to.
 */
import { ADJUSTMENT_KINDS } from '@atelier/shared';
import type { Translations } from '../../locales';

export type HelpCategoryId =
  | 'start' | 'draw' | 'fill' | 'select' | 'layers' | 'vector' | 'text' | 'anim' | 'collab' | 'touch' | 'ui' | 'files' | 'keys';

export type HelpArtId = 'two-finger-tap' | 'three-finger-tap' | 'pinch' | 'long-press' | 'dock' | 'transform' | 'space-pan';

export interface HelpKey {
  /** ShortcutManager action id (shown with the user's current key) */
  action?: string;
  /** Fixed key text for things that are not rebindable (Space, Alt, Enter…) */
  fixed?: string;
  label: string;
}

export interface HelpTopic {
  id: string;
  category: HelpCategoryId;
  title: string;
  summary: string;
  steps?: string[];
  keys?: HelpKey[];
  art?: HelpArtId;
  /** Extra search words: synonyms, English, common misspellings */
  keywords: string[];
}

export function getAdjustmentHelpTopic(t: Translations): HelpTopic {
  const { add, title, kinds, help } = t.layers.adjustment;
  const kindLabels = ADJUSTMENT_KINDS.map((kind) => kinds[kind]);
  return {
    id: 'adjustment-layers',
    category: 'layers',
    title,
    summary: help.summary,
    steps: [
      help.create.replace('{kinds}', kindLabels.join(' · ')),
      help.scope, help.coverage, help.edit, help.psd, help.psdLimits, help.psdGroup, help.flattened,
    ],
    keywords: [add, ...kindLabels, 'PSD', 'ORA', 'Ctrl+Z'],
  };
}

export function getAutoActionsHelpTopic(t: Translations): HelpTopic {
  const { title, help, record, play, builtinBadge } = t.autoActions;
  return {
    id: 'auto-actions',
    category: 'ui',
    title,
    summary: help.summary,
    steps: [help.record, help.supported, help.play, help.files],
    keywords: [title, record, play, builtinBadge, 'action', 'macro', 'Ctrl+Z', '.lumina-action'],
  };
}

export function getSoftProofHelpTopic(t: Translations): HelpTopic {
  const { title, menuProof, menuGamut, menuSettings, help } = t.softProof;
  return {
    id: 'soft-proof',
    category: 'files',
    title,
    summary: help.summary,
    steps: [help.enable, help.gamut, help.profiles, help.local, help.embed],
    keywords: [title, menuProof, menuGamut, menuSettings, 'CMYK', 'ICC', 'ICM', 'soft proof', 'gamut', 'FOGRA39',
      'Japan Color', 'SWOP', '印刷', '校樣', '校样', '色域'],
  };
}

export function getKraExportHelpTopic(t: Translations): HelpTopic {
  const { kra, kraHelp } = t.export;
  return {
    id: 'kra-export',
    category: 'files',
    title: kra,
    summary: kraHelp.summary,
    steps: [kraHelp.kept, kraHelp.adjustments, kraHelp.clipping, kraHelp.reopen],
    keywords: [kra, 'Krita', '.kra', 'kra', 'export', 'inherit alpha', '匯出', '导出'],
  };
}

export const HELP_CATEGORIES: Array<{ id: HelpCategoryId; label: string }> = [
  { id: 'start', label: '快速上手' },
  { id: 'draw', label: '繪畫' },
  { id: 'fill', label: '填色' },
  { id: 'select', label: '選取與變形' },
  { id: 'layers', label: '圖層' },
  { id: 'vector', label: '向量' },
  { id: 'text', label: '文字與漫畫' },
  { id: 'anim', label: '動畫' },
  { id: 'collab', label: '多人協作' },
  { id: 'touch', label: '觸控手勢' },
  { id: 'ui', label: '介面與版面' },
  { id: 'files', label: '匯出與存檔' },
  { id: 'keys', label: '全部快捷鍵' },
];

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'remember-account', category: 'collab', title: '記住帳號與切換伺服器',
    summary: '登入時預設勾選「記住帳號」。下次開啟同一台伺服器的登入表單會帶入帳號，密碼請自行輸入。',
    steps: ['切回已登入的伺服器時會恢復該伺服器的登入狀態。', '要移除預填的帳號，取消勾選「記住帳號」後登入。'],
    keywords: ['帳號', '登入', '換伺服器', 'remember username', 'sign in'],
  },
  // ---- 快速上手
  {
    id: 'first-stroke', category: 'start', title: '開始畫第一筆',
    summary: '選左側工具列的筆刷，在畫布上直接畫。最左邊的兩條直條：上半是大小、下半是不透明度。',
    steps: ['按 B 切到筆刷', '拖最左側直條調整大小與不透明度，或點上方數字直接輸入', '右側「色彩」面板選顏色'],
    keys: [{ action: 'tool_brush', label: '筆刷' }, { action: 'action_brush_larger', label: '筆刷變大' }, { action: 'action_brush_smaller', label: '筆刷變小' }],
    keywords: ['開始', '入門', '新手', '畫畫', '筆刷', '大小', '不透明度', 'brush', 'size', 'opacity'],
  },
  {
    id: 'undo', category: 'start', title: '復原與重做',
    summary: '只會復原你自己的動作；別人在你之後畫的內容會保留。',
    keys: [{ action: 'action_undo', label: '復原' }, { action: 'action_redo', label: '重做' }],
    steps: ['觸控：雙指點一下＝復原、三指點一下＝重做'],
    art: 'two-finger-tap',
    keywords: ['復原', '撤銷', '上一步', '還原', '重做', 'undo', 'redo', 'ctrl+z', 'ctrl+y', '雙指', '三指'],
  },
  {
    id: 'navigate', category: 'start', title: '移動、縮放與旋轉畫面',
    summary: '按住空白鍵拖曳就能平移；滾輪縮放，Shift+[ ] 旋轉。',
    keys: [
      { fixed: 'Space', label: '按住平移' },
      { action: 'action_zoom_in', label: '放大' },
      { action: 'action_zoom_out', label: '縮小' },
      { action: 'action_view_rotate_left', label: '左轉' },
      { action: 'action_view_rotate_right', label: '右轉' },
      { action: 'action_view_flip', label: '左右翻轉畫面' },
      { action: 'action_reset_view', label: '重設視角' },
    ],
    art: 'space-pan',
    keywords: ['平移', '移動畫面', '縮放', '放大', '縮小', '旋轉', '翻轉', '鏡像', 'zoom', 'pan', 'rotate', 'flip', '空白鍵', 'space', '抓手'],
  },
  {
    id: 'eyedropper', category: 'start', title: '吸取顏色',
    summary: '任何繪圖工具按住 Alt 點一下畫布就能吸色；也可以切到滴管工具。',
    keys: [{ fixed: 'Alt', label: '按住吸色' }, { action: 'tool_eyedropper', label: '滴管' }],
    keywords: ['吸色', '滴管', '取色', '吸管', 'eyedropper', 'picker', 'alt'],
  },
  {
    id: 'resume', category: 'start', title: '回到上次的畫布',
    summary: '入口最上方的「繼續上次」卡會顯示你上次打開的畫布或房間，確認還在之後點一下就進入。',
    steps: [
      '入口會用上次的模式打開；多人連線時，房間列表會先選好你上次去的房間。',
      '房間被刪除或伺服器連不上時，卡片會變灰並說明原因，可以重新確認或從最近移除。',
      '單機模式的「最近的單機畫布」列在最上面，點縮圖就能打開。',
      '紀錄只存在這台裝置。',
    ],
    keywords: ['繼續', '上次', '最近', '快速進入', '畫廊', '房間', 'resume', 'continue', 'recent', 'gallery'],
  },

  // ---- 繪畫
  {
    id: 'brush-settings', category: 'draw', title: '筆刷設定',
    summary: '上方選項列有硬度與防手震；「筆刷設定」裡可調間距、散佈、筆跡動態、色彩混合、紙紋與雙重筆刷。',
    steps: [
      '筆跡動態：可分別開關大小、不透明度、流量隨筆壓、傾斜或運筆速度變化，並調整動態下限與隨機抖動',
      '色彩混合：支援「混色」（與畫布底色融合並補充顏料）、「純塗抹」（不補新色、純推移底色）與「濕染稀釋」（水彩暈開），並可開啟「水彩濕邊緣」與「主副色混合」',
      '紙紋與雙重筆刷：可切換紙紋混合模式（鏤空／相乘／覆蓋）、反轉紙紋、上傳自訂紙紋圖，並可替雙重筆刷指定獨立副筆尖與交集／挖空／變暗模式',
      '匯入外部筆刷檔（.abr／.sut／.brush／.brushset）時，會自動還原筆尖貼圖與內嵌的尺寸、間距、動態、混色及紙紋設定',
      '筆刷、鉛筆、橡皮擦各自記住自己的設定；既有防手震演算法維持獨立運作',
    ],
    keywords: ['筆刷設定', '硬度', '防手震', '穩定', '間距', '散佈', '動態', '筆壓', '不透明度', '流量', '傾斜', '速度', '紋理', '紙紋', '混色', '純塗抹', '稀釋', '濕邊緣', '主副色', '雙重筆刷', '筆尖', '匯入', 'abr', 'sut', 'stabilizer', 'spacing', 'texture', 'hardness', 'dynamics', 'wet mix'],
  },
  {
    id: 'pressure', category: 'draw', title: '繪圖板與感壓',
    summary: '支援 Wacom、Apple Pencil、Surface Pen 的感壓與傾斜。到「設定 → 筆壓測試」試筆。',
    keywords: ['感壓', '壓感', '筆壓', '繪圖板', '數位板', 'wacom', 'apple pencil', 'pressure', 'tilt', '傾斜'],
  },
  {
    id: 'outline-brush', category: 'draw', title: '描邊筆刷',
    summary: '勾選選項列的「描邊」，同色筆劃會合成一塊並在外圈自動描邊。',
    steps: ['描邊色可用色輪或滴管指定', '套索填色也能套用同一組描邊設定'],
    keywords: ['描邊', '外框', '邊框', 'outline', 'stroke', '貼紙風'],
  },
  {
    id: 'eraser', category: 'draw', title: '橡皮擦與套索擦除',
    summary: '橡皮擦有自己的筆刷設定；勾選「套索擦除」可以圈起範圍整塊擦掉。',
    keys: [{ action: 'tool_eraser', label: '橡皮擦' }],
    keywords: ['橡皮擦', '擦除', '擦掉', 'eraser', '套索擦除'],
  },
  {
    id: 'blur-smudge', category: 'draw', title: '模糊與揉色',
    summary: '模糊只在原地把顏色柔化；揉色像用手指抹開顏料，把筆下的顏色沿筆畫方向拖出去並漸漸變淡。',
    steps: ['選項列的「強度」越高，模糊越柔、揉色拖得越遠', '兩者都只改目前圖層'],
    keys: [{ action: 'tool_blur', label: '模糊' }, { action: 'tool_smudge', label: '揉色' }],
    keywords: ['模糊', '揉色', '暈染', '混色', '指尖', '塗抹', '抹開', 'blur', 'smudge', 'finger'],
  },
  {
    id: 'rulers', category: 'draw', title: '對稱、透視與平行尺規',
    summary: '尺規視窗可開對稱（鏡像、放射）、1–3 點透視、平行線與同心圓。拖曳畫布上的中心點或滅點調整位置。',
    keys: [{ action: 'action_studio_ruler', label: '尺規' }],
    keywords: ['尺規', '對稱', '鏡像', '萬花筒', '透視', '滅點', '平行線', '同心圓', 'ruler', 'symmetry', 'perspective', 'mandala'],
  },

  // ---- 填色
  {
    id: 'bucket', category: 'fill', title: '油漆桶',
    summary: '點封閉區域填滿。可參照目前圖層、所有圖層或只填選區；容差控制顏色範圍。',
    steps: ['多人畫布即將整張填色時會先詢問，確認後才套用與同步。單機可在油漆桶工具選項隨時開關「整張填色前確認」。'],
    keys: [{ action: 'tool_bucket', label: '油漆桶' }],
    keywords: ['油漆桶', '填色', '填滿', '上色', 'bucket', 'fill', '容差', 'tolerance'],
  },
  {
    id: 'lasso-fill', category: 'fill', title: '套索填色',
    summary: '油漆桶切到「套索填色」後，圈出形狀就直接填滿目前顏色。',
    steps: ['調整消除鋸齒可改變填色邊緣。關閉時為硬邊，開啟時保留邊緣像素的部分覆蓋率。'],
    keywords: ['套索填色', '圈選填色', 'lasso fill'],
  },
  {
    id: 'smart-fill', category: 'fill', title: '智能填色',
    summary: '在底色圖層圈住線稿範圍，自動依線稿封閉區域填色並補小缺口，色塊會延伸到線下。',
    keys: [{ action: 'tool_smart_fill', label: '智能填色' }],
    keywords: ['智能填色', '自動上色', '平塗', '底色', 'flat', 'auto fill', '補縫', '缺口'],
  },
  {
    id: 'gradient', category: 'fill', title: '漸層',
    summary: '拖曳拉出線性或放射漸層，使用目前的前景色與背景色。',
    keys: [{ action: 'tool_gradient', label: '漸層' }],
    keywords: ['漸層', '漸變', 'gradient', '放射', '線性'],
  },
  {
    id: 'color-adjust', category: 'fill', title: '濾鏡、色彩預設與濾鏡庫',
    summary: '畫布下方「濾鏡」依 8 個分組列出圖層濾鏡；支援風格預設卡片、濾鏡庫縮圖瀏覽、個人收藏，以及套用到上方新圖層。',
    steps: [
      '分組：色彩濾鏡、濾鏡庫、修正線稿、描繪、效果、模糊、變形、銳化。手機上點分組名稱即可展開。',
      '參數可以拖滑桿，也可以在數字框直接輸入；可往正負兩邊調的滑桿會從中間往兩側填色。按 ↺ 恢復預設值，按 ★ 可把目前參數存進個人收藏，按 ← 回到分組。',
      '「色彩調整」在同一個視窗提供流光原創風格預設卡片（原圖、晨曦暖光、暮色微涼、柔霧淡彩、鮮明漫畫、懷舊底片、清透水色、冷峻高反差）與 6 支滑桿，點卡片即可預覽並繼續微調。',
      '「單色著色」可將畫面依明暗映射成單一色調，勾選「保留明暗層次」時黑與白維持原貌、中間調呈現指定色。',
      '「色階」上方的圖表是圖層的明暗分布：黑點與白點之外的部分會變暗，灰線是中間調的位置；中間調往正值調會變亮。',
      '「二值化」可以只處理顏色（黑或白）、只處理透明度（全透明或不透明），或兩者一起。',
      '「濾鏡庫」會用縮圖卡片列出精選組合與你的個人收藏：點一下縮圖就能在主畫布即時預覽，下方立即展開參數可微調；個人收藏可重新命名或刪除，儲存在本機裝置。',
      '勾選「套用到新圖層」（參數濾鏡、色調曲線、漸層對應皆支援）會把可見圖層合成後套用濾鏡，並把結果建立在目前圖層正上方的新點陣圖層，不改動原圖層，按一次復原即可移除。需要底色時可加勾「含背景」。',
      '選中文字、向量或群組圖層時，開啟濾鏡會自動切換為「套用到新圖層」模式，不必手動點陣化；超大畫布會依裝置記憶體上限啟用草稿預覽、跳出確認提醒，或於行動端限制合成以防閃退。',
      '每個濾鏡會記住你上次套用的參數（存在本機）；有選取範圍時只處理範圍內；「變形」裡的液化與網格變形會直接切換到對應的工具。',
    ],
    keys: [{ action: 'action_filter_curves', label: '色調曲線' }, { action: 'action_filter_gradient_map', label: '漸層對應' }],
    keywords: ['濾鏡', '濾鏡庫', '收藏', '預設', '色彩預設', '單色著色', '套用到新圖層', '新圖層', '合併可見', '色調曲線', '曲線', '色階', '漸層對應', '調色', 'curves', 'gradient map', 'filter', 'filter library', 'favorites', 'mono tint', '模糊濾鏡', '負片', '濾鏡分組', '液化', '網格變形', '雜訊', '網點',
      '色彩調整', '亮度', '對比', '色相', '彩度', '飽和度', '色溫', '色調', '灰階', '黑白', '二值化', 'levels', 'brightness', 'contrast', 'hue', 'saturation', 'threshold', 'grayscale', '直方圖'],
  },
  {
    id: 'filter-lineart', category: 'fill', title: '修正線稿',
    summary: '「濾鏡 → 修正線稿」整理掃描或手繪的線條：調粗細、清掉雜點、抽取線稿、統一線色與平滑鋸齒。直接套用時僅限一般點陣圖層。',
    steps: [
      '線條粗細：正值加粗、負值變細，單位是每一邊的像素。勾選「變細時至少保留 1 px」，細線就不會整條消失。',
      '去除雜點：「大小上限」以內的色塊會被處理。可以刪掉小色點、刪掉白底上的深色點，或把線條間的透明小縫補起來（用周圍顏色或目前的筆刷色）。碰到畫布邊緣的縫不會補。',
      '抽取線稿：白紙變透明，線條依深淺保留透明度。「視為白紙的範圍」調高，淡淡的紙色也會被去掉；勾選「保留線條顏色」會留下彩色線條，否則一律變成黑線。',
      '統一線色：所有線條換成目前的筆刷色，或取消勾選後自己挑顏色；透明度不變。',
      '平滑鋸齒：專門柔化斜線與曲線邊緣的階梯鋸齒，同時保持純水平與純垂直線條銳利。',
      '透明度一半以上的像素才算線條，所以很淡的鉛筆線可能先用「色階」或「二值化」加深再處理。遮色片圖層直接套用時不能使用修正線稿（可改勾「套用到新圖層」）。',
    ],
    keywords: ['修正線稿', '線稿', '線條', '加粗', '變細', '線寬', '雜點', '去除雜點', '去污點', '補縫', '抽取線稿', '線稿抽出', '白色轉透明', '去背', '統一線色', '線色', '平滑鋸齒', '抗鋸齒',
      'line art', 'lineart', 'despeckle', 'line width', 'extract lines', 'recolor', 'smooth jaggies', 'anti-alias'],
  },
  {
    id: 'filter-effects', category: 'fill', title: '描繪、效果、模糊、變形與銳化',
    summary: '含描繪（柏林雜訊、格線、集中線）、浮雕、投影、邊緣轉線稿、極座標、鋸齒波紋、捏合與高反差保留；支援畫布中心點拖曳與大畫布草稿預覽。',
    steps: [
      '中心點：漩渦、旋轉模糊、放射模糊、球面化、捏合、鋸齒波紋、集中線與放射狀色差都可直接在畫布拖曳圓點調整中心；按「置中」放回中央，選取圓點後也可用方向鍵微調（Shift 一次 10 px）。',
      '有半徑的濾鏡（漩渦、球面化、捏合）會在中心點外畫出虛線圈，表示影響範圍。',
      '描繪：柏林雜訊可調整縮放、強度、衰減、層數與偏移；格線與集中線會直接疊畫在圖層或透明新圖層上，方便製作透視參考格或漫畫速度集中線。',
      '效果：浮雕可選擇中性灰階（適合搭配覆蓋混合模式）或保留原色；投影可設偏移、模糊、透明度與「僅保留陰影」；邊緣轉線稿可快速擷取輪廓線並選擇透明底或白底；外框線可畫在外側、內側或跨邊；發光可讓亮部向外暈開。',
      '模糊：動態模糊 0° 朝右、90° 朝上，支援雙向／只往前／只往後；放射模糊支援往外／往中心／雙向。',
      '變形：球面化可外凸或內縮並調扁平；捏合可依半徑向中心收緊或撐開；極座標支援「直角 ↔ 極座標」雙向轉換；鋸齒波紋提供池塘水波與放射旋紋。',
      '銳化：進階銳化的「門檻」越高越只處理明顯邊緣；高反差保留會以中性灰（128）保留邊緣細節，搭配「套用到新圖層」再切覆蓋／柔光混合模式即可做非破壞性銳化。',
      '畫布很大時（手機和平板門檻較低），重運算濾鏡會先顯示較粗草稿，參數停下後換成完整預覽；標題下方流光跑動代表仍在計算，套用時一律採完整解析度。',
    ],
    keywords: ['描繪', '柏林雜訊', '格線', '集中線', '效果', '馬賽克', '發光', '光暈', '外框線', '描邊', '浮雕', '投影', '陰影', '邊緣轉線稿', '色差', '放射狀', '動態模糊', '放射模糊', '柔化', '波浪', '球面化', '魚眼', '極座標', '鋸齒波紋', '波紋', '捏合', '銳化', 'USM', '高反差保留', '中心點',
      '草稿預覽', '預覽很慢', '大畫布',
      'perlin', 'grid', 'focus lines', 'emboss', 'drop shadow', 'edge', 'polar', 'ripple', 'pinch', 'high pass', 'mosaic', 'glow', 'outline', 'stroke', 'motion blur', 'zoom blur', 'radial blur', 'soften', 'wave', 'spherize', 'fisheye', 'sharpen', 'unsharp mask', 'draft preview'],
  },

  // ---- 選取與變形
  {
    id: 'selection', category: 'select', title: '選取範圍',
    summary: '套索、魔術棒、選取筆都能建立選區；按住 Shift 加選、Ctrl 減選。',
    keys: [
      { action: 'tool_lasso', label: '套索' },
      { action: 'tool_magic_wand', label: '魔術棒' },
      { action: 'action_selection_invert', label: '反選／全選' },
      { action: 'action_clear_selection', label: '取消選取' },
    ],
    steps: ['選區列可擴大、縮小、羽化或變成蒙版'],
    keywords: ['選取', '選區', '套索', '魔術棒', '加選', '減選', '反選', '全選', '羽化', 'selection', 'lasso', 'magic wand', 'feather'],
  },
  {
    id: 'clipboard', category: 'select', title: '複製、剪下與貼上',
    summary: '貼上會出現在原位，可直接拖動縮放，Enter 確定。勾選「貼到新圖層」會另開一層。',
    keys: [
      { action: 'action_selection_copy', label: '複製' },
      { action: 'action_selection_cut', label: '剪下' },
      { action: 'action_selection_paste', label: '貼上' },
      { action: 'action_selection_delete', label: '清除選取內容' },
    ],
    keywords: ['複製', '剪下', '貼上', '剪貼簿', 'copy', 'paste', 'cut', '刪除選取'],
  },
  {
    id: 'transform', category: 'select', title: '自由變形',
    summary: '有選區時變形選區，否則變形整個圖層有內容的範圍。拖曳框線縮放、上方圓點旋轉。',
    keys: [
      { action: 'action_filter_free_transform', label: '自由變形' },
      { fixed: 'Shift', label: '等比' },
      { fixed: 'Alt', label: '以中心縮放' },
      { fixed: 'Enter', label: '套用' },
      { fixed: 'Esc', label: '取消' },
    ],
    art: 'transform',
    keywords: ['變形', '移動', '縮放', '旋轉', '移動工具', 'transform', 'move', 'scale', 'rotate', '自由變形'],
  },
  {
    id: 'warp', category: 'select', title: '網格變形與歪斜',
    summary: '變形列的模式選單可換成網格變形、遠近歪斜、平行歪斜或自由歪斜，拖曳控制點即可。',
    keys: [{ action: 'action_filter_mesh_warp', label: '網格變形' }],
    keywords: ['網格變形', '歪斜', '透視變形', '扭曲', 'mesh', 'warp', 'distort', 'perspective'],
  },
  {
    id: 'liquify', category: 'select', title: '液化',
    summary: '推移、膨脹、縮小或旋轉像素；筆刷大小決定影響範圍。',
    keys: [{ action: 'action_filter_liquify', label: '液化' }],
    keywords: ['液化', '推移', '膨脹', '縮小', '旋轉', 'liquify', 'push', 'bloat', 'pinch'],
  },

  // ---- 圖層
  {
    id: 'layer-basics', category: 'layers', title: '新增與管理圖層',
    summary: '新圖層建立在目前圖層上方並自動選取。雙擊名稱或按 F2 重新命名，拖曳排序。',
    keys: [
      { action: 'action_layer_new_raster', label: '新點陣圖層' },
      { action: 'action_layer_new_vector', label: '新向量圖層' },
      { action: 'action_layer_rename', label: '重新命名' },
      { action: 'action_layer_duplicate', label: '製作副本' },
      { action: 'action_layer_delete', label: '刪除圖層' },
    ],
    keywords: ['圖層', '新增圖層', '新圖層', '刪除圖層', '重新命名', '改名', '副本', 'layer', 'rename', 'duplicate'],
  },
  {
    id: 'layer-menu', category: 'layers', title: '圖層右鍵選單',
    summary: '右鍵（觸控長按）圖層：複製／貼上圖層、群組、向下合併、加蒙版、移出圖層組。刪除圖層組會連同裡面的圖層一起刪除（別人的圖層會留下、移到組外），Ctrl+Z 整組復原。',
    keys: [
      { action: 'action_layer_new_group', label: '群組' },
      { action: 'action_layer_merge_down', label: '向下合併' },
      { action: 'action_layer_copy', label: '複製圖層' },
      { action: 'action_layer_paste', label: '貼上圖層' },
    ],
    keywords: ['右鍵', '長按', '群組', '圖層組', '資料夾', '刪除資料夾', '刪除圖層組', '合併', '向下合併', '複製圖層', '貼上圖層', 'group', 'merge'],
  },
  {
    id: 'clip-mask', category: 'layers', title: '剪裁、α 鎖與蒙版',
    summary: '剪裁：筆觸只出現在下方圖層有顏色的地方。α 鎖：只能畫在已有像素上。蒙版：黑色隱藏、白色顯示。',
    keys: [{ action: 'action_layer_toggle_clip', label: '剪裁' }, { action: 'action_layer_toggle_alpha', label: 'α 鎖' }],
    keywords: ['剪裁', '剪裁遮罩', 'clipping', 'alpha', 'α鎖', '鎖定透明度', '蒙版', '遮罩', 'mask', '隱藏'],
  },
  {
    id: 'layer-align', category: 'layers', title: '對齊與均分圖層',
    summary: '把單個或多個圖層、群組、向量筆畫或文字圖層以整數像素對齊或均分，支援輔助線基準、單步復原與即時多人同步。',
    steps: [
      '從畫布下方工具列的「對齊」按鈕，或圖層右鍵選單的「對齊…」打開浮動視窗；視窗可常駐開啟並連續操作。',
      '支援多選操作：在圖層面板按住 Ctrl / Shift 點選，或開啟手機版批量模式選取多個圖層；選取群組時會把整個群組視為單一對象一起移動，有蒙版的圖層也會連同蒙版一起平移。',
      '基準選「自動」時會依序採用：有選取範圍用「選取範圍」→ 畫布上有可見輔助線用「輔助線」→ 選取 2 個以上對象用「對齊對象」（共同外框）→ 其餘用「畫布」；旁邊會顯示目前套用的基準，設定記在自己的瀏覽器。',
      '輔助線基準：可在「尺規與輔助線」視窗（或對齊視窗內的「輔助線」捷徑）新增水平／垂直輔助線、輸入精確座標或直接拖曳畫布上的輔助線；點選輔助線（Shift 多選）可指定為對齊基準。單條輔助線僅啟用對應軸向的對齊，2 條以上同軸輔助線支援「範圍」與「最近」模式，並可在兩條線之間進行均分。',
      '向量圖層與個別筆畫：單選向量圖層時可切換「整層」、「已選筆畫」或「全部筆畫」為對象（使用節點編輯工具按住 Shift 點選可多選筆畫），並可切換依「含筆寬」或「路徑線」計算邊界；移動時會精確同步平移錨點與控制柄，保持單步復原與即時同步。',
      '文字圖層邊界切換：選取文字圖層時可切換依「字形範圍」（實際墨跡外框）或「文字框」（文字編輯框）計算對齊與均分位置，移動後完整保留可編輯文字屬性並支援單步復原。',
      '上方九宮格區：框上方三個按鈕只對齊左右、左側三個只對齊上下，框裡的九宮格同時對齊兩個方向。下方「均分」區提供水平與垂直共 8 種均分（左／右／上／下緣、水平／垂直中心、水平／垂直等間隔），需至少 2 個對象。',
      '選取範圍只是對齊用的外框：整個圖層一起移動，不會只搬框裡的部分，也不會被裁切；若移動後部分內容會超出畫布，會先詢問是否裁切。',
      '不論一次移動多少個圖層、群組、蒙版或向量筆畫，按一次復原（Ctrl+Z）就會全部一起回到原位。',
      '單獨選取蒙版、選取中包含鎖定或他人無權編輯的圖層、動畫資料夾、或有關鍵影格的圖層時會整批暫停操作，不會產生部分位移。',
    ],
    keywords: ['對齊', '均分', '分布', '等間隔', '置中', '靠左', '靠右', '靠上', '靠下', '居中', '對齊畫布', '對齊選取範圍', '對齊對象', '輔助線', '垂直輔助線', '水平輔助線', '向量筆畫', '路徑線', '字形範圍', '文字框', '多圖層', '群組', 'align', 'distribute', 'guide', 'spacing', 'center', '整列', '对齐'],
  },
  {
    id: 'layer-props', category: 'layers', title: '混合模式、不透明度與網點',
    summary: '圖層面板上方的屬性列作用在選取中的圖層：混合模式、不透明度、剪裁、鎖定、網點。',
    keywords: ['混合模式', '色彩增值', '濾色', '覆蓋', '不透明度', '網點', 'blend', 'multiply', 'screen', 'overlay', 'screentone'],
  },
  {
    id: 'local-eye', category: 'layers', title: '只在自己畫面隱藏',
    summary: '每列左側下方的小眼睛只影響你的畫面，不會影響其他畫師。',
    keywords: ['小眼睛', '隱藏', '只有我', '本機', '可見', 'visibility', 'hide'],
  },

  // ---- 向量
  {
    id: 'vector-draw', category: 'vector', title: '畫向量線',
    summary: '在向量圖層用向量筆徒手畫，或用鋼筆：點擊放尖角、拖曳拉出曲線，Enter 或雙擊完成。',
    keys: [{ action: 'tool_vector_pen', label: '向量筆' }, { action: 'tool_vector_bezier', label: '鋼筆' }],
    keywords: ['向量', '向量筆', '鋼筆', '貝茲', '曲線', '線稿', 'vector', 'bezier', 'pen'],
  },
  {
    id: 'vector-edit', category: 'vector', title: '修線',
    summary: '節點編輯拖曳節點與控制桿；捏線拉動整段；線寬修正讓線加粗或變細；向量橡皮擦擦到交點。',
    keys: [
      { action: 'tool_vector_edit', label: '節點編輯' },
      { action: 'tool_vector_reshape', label: '捏線' },
      { action: 'tool_vector_width', label: '線寬修正' },
      { action: 'tool_vector_eraser', label: '向量橡皮擦' },
    ],
    keywords: ['修線', '節點', '控制桿', '捏線', '線寬', '交點', '向量橡皮擦', 'node', 'reshape', 'width'],
  },

  // ---- 文字與漫畫
  {
    id: 'text', category: 'text', title: '文字（橫排與直排）',
    summary: '點畫布直接打字，可切直排；標點、英文與數字會自動轉成直排樣式。Ctrl+Enter 或點畫布其他地方完成。',
    keys: [{ action: 'tool_text', label: '文字' }, { fixed: 'Ctrl+Enter', label: '完成' }, { fixed: 'Esc', label: '取消' }],
    keywords: ['文字', '打字', '直排', '橫排', '字型', '字級', 'text', 'font', 'vertical', '注音'],
  },
  {
    id: 'comic', category: 'text', title: '漫畫分格與對話氣泡',
    summary: '分格工具拖曳切割分格；氣泡可拖曳縮放、移動尾巴。完成後按「套用」畫進圖層。',
    keys: [{ action: 'tool_comic_panel', label: '分格' }, { action: 'action_studio_comic', label: '漫畫工具' }],
    keywords: ['漫畫', '分格', '分鏡', '對話框', '氣泡', 'comic', 'panel', 'balloon'],
  },

  // ---- 動畫
  {
    id: 'anim-basics', category: 'anim', title: '逐格動畫',
    summary: '時間軸上每個動畫資料夾是一軌、裡面每個圖層是一格（在圖層面板列在資料夾下方，越新的格越上面）。格子可以拖到任何一格，中間空著的格會延續前一張畫面；拖 cel 右緣改停留格數。',
    steps: [
      '點一格選取，Shift＋點選一段，Ctrl＋點加入或取消',
      '選好按 Ctrl+C，點要貼的那一格再按 Ctrl+V',
      '播放頭停在最後一張之後按「加格」，新的一張就放在那一格',
      '洋蔥皮只在自己打開時間軸時顯示，前後各可看 0–10 張，離目前這格越遠越淡',
      '洋蔥皮有三種顯示方式：「色調」把前後張塗成單色；「明暗」用同一個顏色保留線條和上色的深淺；「原色」不上色，只把那張變淡',
      '按「× 空白格」會在播放頭放一格空白：這一軌在那幾格什麼都不顯示，播放和匯出都一樣。重複使用的那張被刪掉時，那一格會加上黃框提醒',
      '停留格數可以直接輸入，最多和時間軸上限一樣；也可以拖格子右緣，拖到時間軸邊緣會自動捲動',
      '播放依實際經過的時間換算格數：畫面跟不上時會跳格，維持原本的速度；切到別的分頁再回來，會從目前這格接著播',
      '原位作畫：在有關鍵影格的圖層上用筆刷、橡皮擦、填色、選取等工具時，這張圖層（和它所在的資料夾）會暫時回到原本畫的位置，筆跡就會落在筆尖下方，畫面上方會顯示「◆ 原位作畫」；播放、換成移動畫面等工具，或打開「關鍵影格與補間」面板時，就恢復成移動後的樣子，筆跡也會跟著移動。匯出不受影響',
      '傳輸列由左到右：跳到最前、上一格、播放、下一格、跳到最後、循環播放（關掉時播一次就停在最後一格）',
      '原畫 ○／中割 ● 與備註：右鍵點擊時間軸上的膠片（或按工具列上的 ○、●、備註按鈕）即可標記與寫備註；記號會顯示在格子角落，備註會顯示於提示文字中，多人會即時同步並隨檔案保存',
      '時間軸標籤：在尺規上雙擊或按右鍵（或按「標籤」按鈕）可在指定格加上短字（例如「眨眼」「台詞」），點標籤直接跳到那一格；多人會同步顯示',
      '重複指定：選取一格或多格後按「重複…」，可設定總循環次數（含原格）或「重複到結尾」，系統會以參照格建立循環；若會動到其他畫師的格則整批拒絕，建立後按一次復原（Ctrl+Z）就能全部撤銷',
      '依序命名：按「依序命名」會依目前出場順序將膠片（含資料夾膠片）改名為 1、2、3…，其他畫師的膠片會自動略過並提示',
      '跳到指定格與關鍵影格：點目前格數即可直接輸入「1+5」或「29」跳轉（格式不合法時維持原格）；在關鍵影格面板或用快捷鍵可跳至上一個／下一個關鍵影格',
      '手翻書：按住手翻書按鍵（預設 `）或按住時間軸上的「手翻書」按鈕，會在目前這格與前後 N 張之間快速來回翻看，放開立即回到原本的格且不留下復原紀錄；張數 N 為個人設定，可在洋蔥皮面板調整',
      '手機版時間軸：在手機上會自動縮成精簡單列（播放、跳格、新增格、洋蔥皮、手翻書），詳細設定收在「更多」底部抽屜，格子右緣的停留拖曳握柄也加寬以利觸控調整',
    ],
    keys: [
      { action: 'action_studio_timeline', label: '時間軸' },
      { action: 'action_anim_prev_frame', label: '上一格' },
      { action: 'action_anim_next_frame', label: '下一格' },
      { action: 'action_anim_first_frame', label: '跳至最前格' },
      { action: 'action_anim_last_frame', label: '跳至最後格' },
      { action: 'action_anim_play', label: '播放／暫停' },
      { action: 'action_anim_onion', label: '洋蔥皮' },
      { action: 'action_anim_add_cel', label: '新增膠片' },
      { action: 'action_anim_add_blank', label: '新增空白格' },
      { action: 'action_anim_prev_keyframe', label: '上一個關鍵影格' },
      { action: 'action_anim_next_keyframe', label: '下一個關鍵影格' },
      { action: 'action_anim_flip', label: '手翻書（按住翻看）' },
      { fixed: 'Ctrl+C／Ctrl+V', label: '複製／貼上格（時間軸上）' },
      { fixed: 'Home／End', label: '跳到最前／最後（點過尺規後）' },
    ],
    keywords: ['動畫', '時間軸', '逐格', '影格', 'cel', '洋蔥皮', '播放', '空白格', '空白', '延續', '停留', '複製格', '貼上格', '多選', '循環', '重複播放', '跳到最後', '色調', '明暗', '原色', '原位作畫', '關鍵影格', '錯位', '原畫', '中割', '備註', '標籤', '重複指定', '依序命名', '跳格', '手翻書', '手機', 'animation', 'timeline', 'onion', 'blank', 'hold', 'fps', 'loop', 'mark', 'note', 'label', 'repeat', 'renumber', 'flipbook'],
  },
  {
    id: 'anim-timing', category: 'anim', title: '中間張、秒＋格與時間軸長度',
    summary: '「加格」會把新膠片放在播放頭那一格，後面的膠片位置不變；要讓後面整段往後推，才打開「順移」。',
    steps: [
      '在 A 和 B 之間加中間張：把播放頭移到想要的那一格再按「加格」，A 會停到前一格，新膠片一直延續到 B',
      '播放頭停在某張膠片的第一格時，新膠片放在下一格',
      '目前的膠片是資料夾時，「加格」會複製整個資料夾結構（子資料夾和空白圖層），接著畫在同一個位置的圖層；動畫資料夾外面的圖層（例如背景）不會被複製，一直顯示',
      '時間顯示為「秒＋格」：0+1 是第 1 格，以 24 FPS 為例，1+1 是第 25 格；點時間顯示可以切換成格數',
      '「範圍」面板可以直接輸入時間軸長度（例如 2+12 或 60），按「自動」就回到最長那一軌的結尾；尺規上的藍線是時間軸結尾',
    ],
    keywords: ['中間張', '補間', '插入', '貼齊', '順移', '秒', '秒加格', '時間碼', '長度', '結尾', '資料夾膠片', '動畫膠片', '背景', 'inbetween', 'timecode', 'length'],
  },
  {
    id: 'anim-lighttable', category: 'anim', title: '透光桌',
    summary: '洋蔥皮會自動顯示前後幾張；透光桌則是自己挑要看的參考膠片，例如畫中間張時只看兩張原畫。只在你的畫面，不會存進檔案。',
    steps: [
      '時間軸上按「透光桌」，選「這張膠片」或「整個軌道」，再點要當參考的膠片',
      '「這張膠片」只在畫目前這張時顯示；「整個軌道」在這軌每一張都顯示',
      '可以調不透明度、一鍵開關，或按「全部解除」；被登記的膠片在時間軸上有燈的圖示',
      '透光桌和洋蔥皮可以同時開；播放時兩者都會隱藏',
    ],
    keywords: ['透光桌', '透光台', '參考', '原畫', '中間張', '洋蔥皮', 'light table', 'reference'],
  },
  {
    id: 'anim-keyframes', category: 'anim', title: '關鍵影格、畫布手把與運動軌跡',
    summary: '在時間軸打開「◆ 關鍵影格與補間」，即可為圖層或群組設定位移、縮放、旋轉、軸心與不透明度動畫，並直接於畫布上拖曳調整。',
    steps: [
      '不透明度關鍵影格：在面板輸入「不透明度 %」（0–100），可製作淡入淡出效果；畫面播放、GIF 與影片匯出都會自動漸變，舊檔未設定時維持 100%',
      '畫布直接拖曳手把：打開關鍵影格面板後，畫布會出現非破壞性變換框與軸心十字，拖曳框體可移動（按住 Shift 鎖定水平／垂直）、拖曳邊角縮放（可切換「等比」鎖定）、拖曳上方旋轉桿旋轉（按住 Shift 吸附 15°）',
      '軸心不跳動補償：拖曳藍色十字軸心可改變旋轉與縮放中心，畫面上的圖層位置會自動補償而不跳動；放開手把後會以單一步驟寫入並同步，按 Ctrl+Z 一次即可復原',
      '運動軌跡：同一圖層有 2 個以上關鍵影格時，畫布會以虛線顯示軸心移動路徑、每格節奏小點與菱形關鍵影格節點；點擊路徑上的關鍵影格點可直接跳至該格。可透過面板「運動軌跡」開關切換（僅本機顯示，絕不會出現在匯出檔案）',
      '曲線預設與迷你貝茲編輯器：可從「曲線預設」直接套用輕／強緩入出、快出慢停、慢起快衝、輕／強回彈，也可拖曳 P1／P2 控制點微調；回彈曲線可呈現超調彈跳，不透明度插值會自動限制在 0%–100% 內',
    ],
    keys: [
      { action: 'action_anim_prev_keyframe', label: '上一個關鍵影格' },
      { action: 'action_anim_next_keyframe', label: '下一個關鍵影格' },
    ],
    keywords: ['關鍵影格', '補間', '不透明度', '淡入', '淡出', '畫布手把', '直接拖曳', '軸心', '運動軌跡', '路徑', '曲線預設', '貝茲', '緩入', '緩出', '回彈', 'keyframe', 'opacity', 'fade', 'handles', 'pivot', 'motion path', 'easing', 'preset', 'bezier', 'bounce'],
  },
  {
    id: 'anim-export', category: 'anim', title: '匯出動畫（影片、GIF、連號圖片與逐張膠片）',
    summary: '點時間軸上的「匯出」可切換四種輸出模式：影片（MP4／WebM）、GIF、連號圖片（PNG）與逐張膠片（PNG／TGA／BMP）；網頁版會打包下載，桌面版可直接選取資料夾逐檔寫入。',
    steps: [
      '影片（MP4／WebM）：支援瀏覽器硬體／離線編碼器時，會以恆定幀率逐格高速離線編碼，速度遠快於即時錄製，並於不支援時自動退回相容錄製模式；支援 1080p／2K／4K 與自訂輸出範圍，中途可按「中止匯出」停止。',
      'GIF：畫面完全相同的連續停留格會合併成較長延遲的影格，有關鍵影格位移或淡入淡出的區間則會逐格輸出。',
      '連號圖片（PNG）：可自訂檔名前綴、後綴、分隔字元、起始編號與補零位數，並即時預覽範例檔名；支援保留透明背景、原尺寸或等比縮放、指定「秒＋格」或格數範圍，以及「每格一張（展開停留）」或「僅不同畫面」兩種張數模式。',
      '逐張膠片與上色用線稿：不依時間軸重複，針對勾選的動畫資料夾每張實際膠片各輸出一檔（複合群組膠片會先合成再輸出），支援「資料夾＋膠片名」或「僅膠片名」，以及 PNG、24／32 位元 TGA 與 24 位元 BMP。開啟「上色用線稿（去反鋸齒二值化）」後，系統會去除抗鋸齒中間色，將像素精確歸類至勾選的指定線色（預設黑色，可加紅、綠、藍或自訂色線並各別微調門檻），其餘像素轉為純白或透明，方便二值化填色流程直接使用。',
      '輸出區域：若畫布上已建立並顯示 2D 攝影機框，影片（MP4／WebM）、GIF 與連號圖片會預設套用每格攝影機平移、縮放與旋轉裁切變換輸出，也可隨時切換回「完整畫布」；未設定攝影機框時預設輸出整張畫布。',
    ],
    keywords: ['gif', 'mp4', 'webm', '影片', '離線編碼', '連號圖片', '連號', 'png', 'tga', 'bmp', '逐張膠片', '膠片輸出', '上色用線稿', '二值化', '去反鋸齒', '透明背景', '匯出動畫', '關鍵影格', '不透明度', '攝影機', '裁切', 'export', 'sequence', 'cel', 'binarize', 'keyframe', 'opacity', 'camera'],
  },
  {
    id: 'anim-camera', category: 'anim', title: '2D 攝影機框與即時預覽',
    summary: '在時間軸點「攝影機框」開啟浮動工具視窗，建立矩形取景框並設定位置、縮放與旋轉關鍵影格，可一鍵切換即時攝影機預覽，並於匯出影片、GIF 與連號圖片時自動套用取景裁切變換。',
    steps: [
      '建立與尺寸：可一鍵套用 16:9、1:1、9:16 或自訂寬高，並開關動作安全框（90%）與標題安全框（80%）參考線；畫布攝影機框會同時以流光邊框與移動軌跡呈現。',
      '關鍵影格運鏡：開啟攝影機視窗或選中攝影機圖層時，可直接拖曳畫布上的中心柄平移、拖曳四角縮放（縮小為拉近特寫、放大為拉遠全景）、拖曳頂部圓柄旋轉（按住 Shift 吸附 15°），或在視窗輸入精確數值並記下／刪除當前格關鍵影格。',
      '即時攝影機預覽：點擊時間軸或工具視窗的「攝影機預覽」後，畫布視窗會立即對齊取景框並遮暗框外區域，播放或拖曳時間軸時即時跟隨鏡頭運動；關閉預覽會自動還原原本的檢視角度。',
      '多人協作與權限：攝影機框與其關鍵影格以圖層形式同步並支援復原，遵守房間圖層權限（僅擁有者可編輯，其餘成員仍可自由開關自己的即時預覽）。',
    ],
    keywords: ['攝影機', '攝影機框', '2d 攝影機', '運鏡', '推拉', '縮放', '旋轉', '平移', '取景', '安全框', '即時預覽', '裁切', '匯出', 'camera', 'framing', 'pan', 'zoom', 'safe area', 'preview'],
  },
  {
    id: 'anim-light-table', category: 'anim', title: '透光桌擴充與個別變形',
    summary: '在時間軸點「透光桌」開啟浮動工具視窗，可同時登記多張膠片或匯入本機參考圖片，為每張參考獨立調整位置、縮放、旋轉、翻轉、不透明度與著色，不影響原本膠片內容。',
    steps: [
      '多參考與本機圖片：可針對「此格」或「整軌」登記多張動畫膠片，或匯入本機圖片檔作為透光桌描圖參考（外部圖片僅存於本機瀏覽器 IndexedDB，不會上傳伺服器）。',
      '個別變形與著色：點選清單中的任一張參考，可單獨調整 X／Y 位移、縮放、旋轉、水平／垂直翻轉、個別不透明度，以及原色／單色／明暗著色；按下「重設變形」立即歸零。',
      '畫布調整參考：開啟「畫布調整參考」後，可直接在畫布上拖曳移動、縮放或旋轉選中的參考，過程完全不修改底層膠片像素。',
      '固定編輯對象鎖：按下「固定編輯對象」可鎖定目前膠片的透光桌參考清單，切換影格檢視其他畫面時仍持續保留該對象的參考配置，直到手動解除固定。',
    ],
    keywords: ['透光桌', '參考', '描圖', '個別變形', '位移', '旋轉', '翻轉', '著色', '固定編輯對象', '本機圖片', 'indexeddb', 'light table', 'reference', 'transform', 'flip', 'tint', 'pin'],
  },
  {
    id: 'anim-audio', category: 'anim', title: '本機音訊軌與時間軸同步',
    summary: '在時間軸點「音訊軌」開啟浮動工具視窗，匯入本機音訊檔於時間軸顯示精簡波形並同步播放與逐格試聽；音檔預設僅存於本機，多人房只同步時間軸配置。',
    steps: [
      '純本機儲存：匯入的音訊檔（WAV／MP3／OGG 等瀏覽器支援格式）僅保存在本機 IndexedDB，不會主動上傳至伺服器，避免大型音檔佔用頻寬與空間。',
      '波形與同步播放：時間軸會依起始格與結束格顯示精簡波形條，播放動畫、循環重播或拖曳跳格時會自動對齊音訊進度；開啟「逐格試聽」後，切換單格時會播放短片段輔助對嘴型與節奏校對。',
      '多人房協作與權限：房間內只同步音訊軌的名稱、起始／結束格、起點秒數、音量與靜音狀態，並遵守既有圖層權限（非擁有者或旁觀者無法修改他人音訊軌設定）。其他成員可點擊「連結本機音檔」掛載自己裝置上的同一音檔以顯示波形並同步聆聽。',
    ],
    keywords: ['音訊', '音訊軌', '聲音', '波形', '對嘴型', '逐格試聽', '同步播放', '靜音', '音量', '本機', 'indexeddb', 'audio', 'waveform', 'scrub', 'lip sync', 'mute'],
  },

  // ---- 多人協作
  {
    id: 'rooms', category: 'collab', title: '房間與邀請',
    summary: '在加入頁選房間或建立新房間，可設密碼。把網址分享給朋友就能一起畫。',
    steps: ['點左上角的 Lumina Drift 圖示或名稱，回到單機與多人連線入口。', '在多人連線頁貼上外部伺服器網址並測試連線。桌面版也能開啟 Cloudflare，並複製產生的公開分享網址。'],
    keywords: ['房間', '邀請', '分享', '密碼', '加入', '建立', 'room', 'invite', '網址', '連線'],
  },
  {
    id: 'connect', category: 'collab', title: '聯機：和朋友一起畫',
    summary: '頂列的「聯機」按鈕（入口頁的「如何和朋友聯機？」）會打開聯機教學。三種方式：同一個 Wi-Fi、虛擬區網（Tailscale、ZeroTier One）、公開連結（Cloudflare Tunnel）。',
    steps: [
      '同一個 Wi-Fi：一台電腦開著桌面版（或伺服器），按右上角「分享連結」複製 192.168. 開頭的網址或 QR Code，朋友用瀏覽器打開就能進房間。',
      '不同地方：大家安裝同一款虛擬區網軟體。Tailscale 登入同一個帳號，或由主持人把電腦分享給朋友；ZeroTier One 在管理頁建立網路，大家輸入同一個 Network ID，再由建立者勾選允許每台裝置。',
      '虛擬區網的網址：Tailscale 是 100.x.x.x，ZeroTier 是管理頁列出的 IP；朋友打開 http://那個網址:3000。聯機教學裡會列出這台電腦目前的網址，可以直接複製。',
      '手機：Tailscale 和 ZeroTier One 都有 iPhone、iPad 與 Android 的 App。安裝後登入或加入同一個網路並開啟 VPN，再用手機瀏覽器打開主持人的網址；手機只當畫畫的一方，不用開伺服器。',
      '只用 Windows 電腦時，Radmin VPN 也能做到一樣的事：加入同一個網路後，用它顯示的 IP 加上 :3000。',
      '公開連結：桌面版按右上角的 Cloudflare 雲朵按鈕，產生 https 公開網址，朋友不用安裝任何東西。關掉後網址失效，下次會換新網址；網址等於房間入口，只分享給要一起畫的人，必要時替房間設密碼。',
      '連不上時：Windows 防火牆要允許「私人網路」；網址要有 :3000（伺服器改用別的埠就換成那個數字）；雙方要在同一個 Wi-Fi 或同一個虛擬區網；學校或公司網路可能擋連線，可以改用公開連結。',
    ],
    keywords: ['聯機', '連線', '一起畫', '多人', '朋友', '區網', '虛擬區網', 'Wi-Fi', 'wifi', 'tailscale', 'zerotier', 'zerotier one', 'radmin', 'vpn', 'cloudflare', 'tunnel', '公開連結', '手機', 'iphone', 'android', '防火牆', 'connect', 'lan', '联机', '接続'],
  },
  {
    id: 'ownership', category: 'collab', title: '每人自己的圖層',
    summary: '每位畫師只能改自己的圖層；別人的圖層會用對方的顏色標示。房主與管理員可直接編輯所有圖層。',
    keywords: ['權限', '擁有者', '別人的圖層', '鎖定', '接管', '管理員', '房主', 'owner', 'permission'],
  },
  {
    id: 'collab-undo', category: 'collab', title: '一起畫時的復原',
    summary: '復原只退回你自己的動作；別人後來畫在同一處的像素會保留，並提示保留了多少。',
    keywords: ['協作復原', '別人', '保留', '衝突', 'undo'],
  },
  {
    id: 'chat-voice', category: 'collab', title: '聊天與語音',
    summary: '右上角聊天室傳訊息；「加入語音」與房間成員通話，M 鍵切換靜音。',
    keys: [{ action: 'action_toggle_mic', label: '靜音' }],
    keywords: ['聊天', '語音', '通話', '麥克風', '靜音', 'chat', 'voice', 'mic'],
  },
  {
    id: 'members', category: 'collab', title: '成員：在線、休眠、離線',
    summary: '「成員」面板分成在線與離線兩區。綠點＝在線；黃點＋「休眠」＝頁面還開著但 5 分鐘沒有操作，一動滑鼠、筆或鍵盤就恢復；離線的人顯示最後上線時間。',
    steps: [
      '作畫時間：每位成員在這張畫布累計畫了多久。兩筆之間停超過 1 分鐘的空檔不算，所以掛著不畫不會增加',
      '游標停在時間上可看精確時間',
      '只有加入過這張畫布的帳號會留在離線名單；訪客離開後就不再顯示',
    ],
    keywords: ['成員', '在線', '離線', '休眠', '閒置', '掛機', '最後上線', '上線時間', '作畫時間', '畫了多久', '時數', 'online', 'offline', 'idle', 'away', 'presence', 'last seen'],
  },
  {
    id: 'member-roles', category: 'collab', title: '房間成員角色與權限',
    summary: '房間成員分為四種角色：房主、管理、畫師、旁觀。在線或離線成員皆會顯示角色徽章，有權限時可於「成員」面板直接切換，變更立即同步到所有分頁並持久化。',
    steps: [
      '房主／伺服器管理員：可將其他一般帳號成員切換為管理、畫師或旁觀；房主、伺服器管理員、訪客與自己不可被修改',
      '房間管理員：可將一般成員（畫師／旁觀）切換為畫師或旁觀，無法修改房主、伺服器管理員或其他房間管理員',
      '畫師：可在自己的圖層或公開／共用圖層作畫、建立圖層、使用貼圖與插件',
      '旁觀（唯讀）：僅能瀏覽畫布、移動視角與聊天，無法落筆、預覽筆跡、變更圖層、編輯貼圖或寫入插件；恢復為畫師後即刻解鎖',
    ],
    keywords: ['角色', '權限', '房主', '管理員', '畫師', '旁觀', '唯讀', '瀏覽者', 'owner', 'admin', 'editor', 'viewer', 'role', 'readonly'],
  },
  {
    id: 'latency', category: 'collab', title: '延遲與連線',
    summary: '右上角綠點表示已連線。延遲高時筆劃仍會完整送達，只是預覽稍慢；操作日誌面板可看延遲。',
    keywords: ['延遲', 'lag', '卡', '連線', '斷線', 'ping', 'latency', '網路'],
  },

  // ---- 觸控
  {
    id: 'gesture-undo', category: 'touch', title: '雙指點／長按：復原',
    summary: '兩根手指同時輕點畫布復原一步；按住兩指不動可連續快速復原。',
    art: 'two-finger-tap',
    keywords: ['雙指', '兩指', '復原', '連續復原', '手勢', 'gesture', 'undo', 'ipad', '平板', '手機'],
  },
  {
    id: 'gesture-redo', category: 'touch', title: '三指點／長按：重做',
    summary: '三根手指同時輕點畫布重做一步；按住三指不動可連續快速重做。',
    art: 'three-finger-tap',
    keywords: ['三指', '重做', '連續重做', '手勢', 'redo'],
  },
  {
    id: 'gesture-pinch', category: 'touch', title: '雙指捏合與快捏符合畫面',
    summary: '兩指張開／合起縮放，轉動兩指旋轉畫面（接近直角會吸附），拖曳平移；快速向內一捏即重置縮放與旋轉符合畫面。',
    art: 'pinch',
    keywords: ['捏合', '快捏', '符合畫面', '縮放', '旋轉', '雙指', 'pinch', 'zoom', 'fit'],
  },
  {
    id: 'gesture-long', category: 'touch', title: '長按：輪盤或吸色環',
    summary: '預設長按畫布叫出快捷輪盤；可在「設定 → 觸控與筆壓」改為長按吸色（附雙色對比色環），也可切換僅觸控筆作畫模式（單指平移或防誤觸）。',
    art: 'long-press',
    keywords: ['長按', '輪盤', '吸色', '滴管', '僅觸控筆', '防誤觸', '單指平移', 'long press', 'radial', 'eyedropper', 'stylus'],
  },
  {
    id: 'gesture-procraft-more', category: 'touch', title: '三指下滑剪貼／四指全螢幕',
    summary: '三指同時下滑喚出剪貼選單（剪下、複製、複製全部、再製、貼上、清除圖層）；四指輕點切換純畫布全螢幕（再四指輕點或點右上按鈕恢復）。',
    art: 'three-finger-tap',
    keywords: ['三指下滑', '剪貼', '複製全部', '清除圖層', '四指', '全螢幕', '隱藏介面', 'fullscreen', 'clipboard', 'procraft'],
  },

  // ---- 介面
  {
    id: 'docking', category: 'ui', title: '拖曳面板：停靠、浮動、合併',
    summary: '拖住面板標題就能移動：拖到畫面邊緣或其他面板之間停靠，拖到空白處變浮動視窗，拖到另一個浮動視窗上合併成分頁。',
    steps: ['把分頁拖出視窗即可分離', '浮動視窗四邊與四角都能調整大小', '濾鏡與對齊可拖曳標題或用標題列按鈕停靠左、右側，再從面板位置選單切回浮動。'],
    art: 'dock',
    keywords: ['面板', '停靠', '浮動', '視窗', '分頁', '拖曳', '合併', '分離', '移動面板', 'dock', 'panel', 'float', 'window', 'tab'],
  },
  {
    id: 'left-handed', category: 'ui', title: '左右互換（左手畫師）',
    summary: '「視窗」選單可讓左右面板互換，或把工具列放右側；也可以直接拖工具列頂端的握把到另一側。',
    keywords: ['左手', '左右', '互換', '工具列', '右側', '左側', 'left handed', 'mirror'],
  },
  {
    id: 'theme', category: 'ui', title: '主題與配色',
    summary: '右上角調色盤圖示選主題，也能自訂明暗、色調與強調色；切換動畫可選擴散、果凍、淡入或關閉。',
    keywords: ['主題', '配色', '深色', '淺色', '顏色', '介面顏色', '強調色', 'theme', 'dark', 'light', 'color'],
  },
  {
    id: 'ui-scale', category: 'ui', title: '介面縮放（放大字與按鈕）',
    summary: '右上角「設定」→ 外觀 → 介面縮放：50%–200%，可拖滑桿、輸入數字或按 −／＋（每次 5%）。只放大介面，畫布不受影響，取代瀏覽器的 Ctrl + / −。面板寬度會一起縮放。',
    keywords: ['縮放', '介面縮放', '放大', '縮小', '字太小', '字體大小', '按鈕太小', '200%', 'ui scale', 'zoom', 'font size'],
  },
  {
    id: 'quick-keys', category: 'ui', title: '指令列與快捷鍵面板',
    summary: '選項列最右側的指令列可放常用動作（點鉛筆圖示自訂）；「視窗 → 快捷鍵面板」是給平板用的大按鈕。',
    keywords: ['指令列', '快捷鍵面板', '自訂按鈕', '常用', 'command', 'quick'],
  },
  {
    id: 'tablet-desktop', category: 'ui', title: '手機與平板的桌面模式',
    summary: '手機打橫仍是手機版介面；「視窗 → 桌面模式」打開後改用電腦版介面，關掉就回到手機版。觸控平板打開後可使用浮動視窗。',
    steps: ['從畫布下方的工具按鈕展開分類工具，選取後回到畫布。點上方的目前工具按鈕可調整筆刷大小、不透明度和工具設定，橫向時兩條滑桿會並排。'],
    keywords: ['手機', '打橫', '橫向', '電腦版', '平板', 'ipad', 'dex', '桌面模式', '浮動'],
  },
  {
    id: 'primary-account', category: 'collab', title: '主帳號與自動登入',
    summary: '單機入口按「登入主帳號」，或登入時勾選「設為主帳號」。同一台伺服器換網址（區網 IP、通道網址）會自動登入；到別人的伺服器會自動註冊同名帳號（名稱被用走時加上 _2），並同步名稱與頭像，密碼由 App 產生並存在這台裝置。需在 App 或本機（localhost）開啟的網頁使用。',
    keywords: ['主帳號', '自動登入', '自動註冊', '同步', '頭像', '名稱', '換網址', '帳號', 'account', 'login'],
  },
  {
    id: 'tourbox', category: 'ui', title: '自訂快捷鍵與 TourBox',
    summary: '設定 → 快捷鍵，點按鍵即可重新綁定。最上方有 TourBox 對照表可直接複製。',
    keywords: ['自訂快捷鍵', '綁定', '按鍵', 'tourbox', 'shortcut', 'keybinding', '熱鍵'],
  },
  {
    id: 'plugins', category: 'ui', title: '插件管理、濾鏡、面板、自訂工具與桌面橋接',
    summary: '上方選單「插件 → 管理插件…」可匯入 .lumina-plugin 套件（支援 API v1 / v2 / v2.5 / v3.0），檢視權限並手動啟用。腳本在隔離沙盒執行，不會存取瀏覽器或帳號。',
    steps: [
      '匯入與啟用：安裝或覆蓋更新後預設為停用並清空先前工作階段授權，確認權限與提供項目（指令／濾鏡／面板／自訂工具／桌面橋接）後再啟用，亦可直接下載內建示範套件試用',
      '自訂濾鏡：啟用後會出現在濾鏡選單的「插件」分組，或歸屬既有分類並帶小拼圖標記，支援即時預覽、選區遮罩、收藏與套用到新圖層',
      '工具面板：從「插件」選單開關浮動面板（桌面記住位置，手機自動改為底部抽屜），長時間執行會顯示流光進度條與中止按鈕',
      '自訂工具與指標事件：具備 tools 與 input 權限的插件會出現在工具列尾端與插件選單，於上方選項列調整參數並在畫布直接拖曳作畫（內建事件節流與逾時保護，整筆拖曳共用單步復原）',
      '時間軸、關鍵影格與筆刷 v2：具備 timeline:read / timeline:write / brush 權限的插件可讀寫時間軸、影格標籤、圖層關鍵影格、自訂三次貝茲緩動與筆刷動態混色（多人房旁觀者與無權圖層會整批拒絕，且不可更動防手震演算法）',
      '桌面外部橋接與本機 MCP（API v3.0）：僅在桌面版單機畫布開放，多人協作房間、網頁版與手機端自動安全停用；外部執行檔須先於「桌面橋接與 MCP…」透過系統檔案視窗綁定並鎖定 SHA-256，每次執行前跳出二次授權確認（可選拒絕／僅此一次／本次工作階段），本機 MCP 伺服器僅監聽 127.0.0.1 並搭配輪換 Bearer 權杖與預設唯讀保護，畫面下方隨時可按「中止全部橋接」即時停止',
      '快捷鍵與復原：在 設定 → 快捷鍵 → 插件 可自訂指令、面板與工具綁定（不覆蓋內建熱鍵）；插件與本機 MCP 對圖層、像素、選區與時間軸的操作皆支援單次 Ctrl+Z 完整還原',
    ],
    keys: [{ action: 'action_undo', label: '單次復原插件操作' }],
    keywords: ['插件', '擴充', '外掛', '濾鏡', '面板', '自訂工具', '時間軸', '關鍵影格', '緩動', '快捷鍵', '權限', '沙盒', '桌面橋接', '外部工具', 'MCP', '授權', 'plugin', 'plugins', 'lumina-plugin', 'api', 'v2.5', 'v3', 'v3.0'],
  },

  // ---- 匯出與存檔
  {
    id: 'import-image', category: 'files', title: '匯入圖片',
    summary: '把圖片拖進畫布，或拖到圖層清單的某個位置，就會變成一張新圖層；比畫布大的圖會等比縮到畫布內。',
    steps: [
      '拖到畫布：以放開的位置為中心',
      '拖到圖層清單：放在藍線的位置（拖到圖層組中間＝放進組裡）',
      '一次只拖一張時會直接出現變形框，調整後按 Enter（Esc 則維持原樣）',
      '也可以用 檔案 → 匯入圖片…（平板、手機適用）',
      '復原會把整張匯入的圖層拿掉，重做會帶著圖片放回來',
    ],
    keys: [{ action: 'action_undo', label: '復原匯入' }, { action: 'action_redo', label: '重做匯入' }],
    keywords: ['匯入', '導入', '插入圖片', '置入', '拖曳', '拖放', '拖入', '讀取檔案', '開啟圖片', '照片', '圖片圖層', 'import', 'drag', 'drop', 'place', 'png', 'jpg', 'jpeg', 'webp'],
  },
  {
    id: 'export', category: 'files', title: '匯出 PNG / PSD',
    summary: '檔案 → 匯出：PNG、PSD（保留圖層、資料夾、蒙版與剪裁）、ORA、ZIP。',
    keywords: ['匯出', '下載', '存檔', 'png', 'psd', 'export', 'save'],
  },
  {
    id: 'autosave', category: 'files', title: '自動儲存',
    summary: '每一筆都即時存到伺服器，不用手動存檔；重新整理後畫面會完整載回。',
    keywords: ['儲存', '存檔', '保存', '自動儲存', 'save', '遺失'],
  },
  {
    id: 'capsule', category: 'files', title: '時光膠囊與縮時重播',
    summary: '時光膠囊保存某個時間點的版本，可還原成新畫布；縮時重播把作畫過程播成影片。',
    keys: [{ action: 'action_studio_history', label: '時光膠囊' }],
    keywords: ['時光膠囊', '版本', '歷史', '備份', '還原', '縮時', '重播', 'timelapse', 'history', 'backup'],
  },
  {
    id: 'resize', category: 'files', title: '調整畫布尺寸',
    summary: '檔案 → 調整畫布尺寸，房間裡每個人的畫布都會一起更新。',
    keywords: ['畫布尺寸', '解析度', '裁切', '擴大畫布', 'resize', 'canvas size'],
  },
  {
    id: 'lumina-project', category: 'files', title: '流光專案檔 (.lumina) 與單人離線作畫',
    summary: '首頁可切換「單人離線作畫」與「多人連線繪茶」。按 Ctrl+S 儲存或 Ctrl+O 開啟 .lumina 開放式專案檔（保留全部圖層、蒙版、向量與動畫，並在 Windows 檔案總管顯示畫布縮圖）。',
    steps: [
      '在首頁選擇「單人離線作畫」即可免開伺服器直接進畫布，自動存進本機 IndexedDB',
      '檔案 → 儲存專案 (.lumina)（Ctrl+S）或另存新檔（Ctrl+Shift+S）',
      '檔案 → 開啟專案 (.lumina)…（Ctrl+O），或直接把 .lumina 檔拖進視窗／在檔案總管連點兩下開啟',
    ],
    keywords: ['lumina', '專案檔', '單人', '離線', '單機', '存檔', '開啟專案', '另存新檔', 'ctrl+s', 'ctrl+o', '縮圖', 'offline', 'project'],
  },
];

/* ---------------- search ---------------- */

/** Lowercase, full-width → half-width, no spaces: 「Ｃｔｒｌ＋Ｚ」 matches "ctrl+z" */
export const normalize = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

export const queryTerms = (q: string) =>
  q.normalize('NFKC').toLowerCase().split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean);

export function getHelpTopics(t: Translations): HelpTopic[] {
  return [
    ...HELP_TOPICS.map((topic) => topic.id === 'text' ? { ...topic, steps: t.textEditor.helpSteps } : topic),
    getAdjustmentHelpTopic(t), getAutoActionsHelpTopic(t), getSoftProofHelpTopic(t), getKraExportHelpTopic(t),
  ];
}

/** Score of a topic for the query (0 = no match). Every term must appear somewhere. */
export const scoreTopic = (topic: HelpTopic, terms: string[], keyText: string) => {
  if (!terms.length) return 0;
  const title = normalize(topic.title);
  const words = topic.keywords.map(normalize);
  const body = normalize([topic.summary, ...(topic.steps ?? []), keyText].join(' '));
  let score = 0;
  for (const t of terms) {
    const nt = normalize(t);
    let s = 0;
    if (title.includes(nt)) s += title.startsWith(nt) ? 14 : 10;
    if (words.some((w) => w === nt)) s += 8;
    else if (words.some((w) => w.includes(nt) || (nt.length >= 2 && nt.includes(w)))) s += 5;
    if (body.includes(nt)) s += 2;
    if (!s) return 0;
    score += s;
  }
  return score;
};

/** Search words the empty state suggests */
export const SUGGESTIONS = ['復原', '圖層', '變形', '透視', '動畫', '停靠', '蒙版', '直排'];
