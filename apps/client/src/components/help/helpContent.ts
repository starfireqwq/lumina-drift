/**
 * The help centre's content: short topics, each with the words people might search for.
 * Key labels are never written here: `keys` names ShortcutManager actions, and the help centre
 * shows whatever the user has bound them to.
 */
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

  // ---- 繪畫
  {
    id: 'brush-settings', category: 'draw', title: '筆刷設定',
    summary: '上方選項列有硬度與防手震；「筆刷設定」裡可調間距、散佈、感壓、紋理、雙重筆刷與混色。',
    steps: ['筆刷、鉛筆、橡皮擦各自記住自己的設定', '「工具屬性」面板可載入自訂筆尖圖片'],
    keywords: ['筆刷設定', '硬度', '防手震', '穩定', '間距', '散佈', '紋理', '混色', '筆尖', 'stabilizer', 'spacing', 'texture', 'hardness'],
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
    keys: [{ action: 'tool_bucket', label: '油漆桶' }],
    keywords: ['油漆桶', '填色', '填滿', '上色', 'bucket', 'fill', '容差', 'tolerance'],
  },
  {
    id: 'lasso-fill', category: 'fill', title: '套索填色',
    summary: '油漆桶切到「套索填色」後，圈出形狀就直接填滿目前顏色。',
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
    id: 'color-adjust', category: 'fill', title: '色調曲線、漸層對應與濾鏡',
    summary: '畫布下方「濾鏡」列出所有圖層濾鏡；色調曲線與漸層對應可以邊拉邊預覽。',
    keys: [{ action: 'action_filter_curves', label: '色調曲線' }, { action: 'action_filter_gradient_map', label: '漸層對應' }],
    keywords: ['濾鏡', '色調曲線', '曲線', '色階', '漸層對應', '調色', 'curves', 'gradient map', 'filter', '模糊濾鏡', '負片'],
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
      '洋蔥皮只在自己打開時間軸時顯示，離目前這格越遠越淡',
    ],
    keys: [
      { action: 'action_studio_timeline', label: '時間軸' },
      { action: 'action_anim_prev_frame', label: '上一格' },
      { action: 'action_anim_next_frame', label: '下一格' },
      { action: 'action_anim_play', label: '播放／暫停' },
      { action: 'action_anim_onion', label: '洋蔥皮' },
      { fixed: 'Ctrl+C／Ctrl+V', label: '複製／貼上格（時間軸上）' },
    ],
    keywords: ['動畫', '時間軸', '逐格', '影格', 'cel', '洋蔥皮', '播放', '空白格', '延續', '複製格', '貼上格', '多選', 'animation', 'timeline', 'onion', 'fps'],
  },
  {
    id: 'anim-export', category: 'anim', title: '匯出 GIF 或影片',
    summary: '檔案 → 匯出，可選只匯出這個資料夾、所有動畫或整張畫，只輸出播放範圍。',
    keywords: ['gif', 'mp4', 'webm', '影片', '匯出動畫', 'export'],
  },

  // ---- 多人協作
  {
    id: 'rooms', category: 'collab', title: '房間與邀請',
    summary: '在加入頁選房間或建立新房間，可設密碼。把網址分享給朋友就能一起畫。',
    steps: ['點左上角的 Lumina Drift 圖示或名稱，回到單機與多人連線入口。', '在多人連線頁貼上外部伺服器網址並測試連線。桌面版也能開啟 Cloudflare，並複製產生的公開分享網址。'],
    keywords: ['房間', '邀請', '分享', '密碼', '加入', '建立', 'room', 'invite', '網址', '連線'],
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
    id: 'latency', category: 'collab', title: '延遲與連線',
    summary: '右上角綠點表示已連線。延遲高時筆劃仍會完整送達，只是預覽稍慢；操作日誌面板可看延遲。',
    keywords: ['延遲', 'lag', '卡', '連線', '斷線', 'ping', 'latency', '網路'],
  },

  // ---- 觸控
  {
    id: 'gesture-undo', category: 'touch', title: '雙指點：復原',
    summary: '兩根手指同時輕點畫布一下。',
    art: 'two-finger-tap',
    keywords: ['雙指', '兩指', '復原', '手勢', 'gesture', 'undo', 'ipad', '平板', '手機'],
  },
  {
    id: 'gesture-redo', category: 'touch', title: '三指點：重做',
    summary: '三根手指同時輕點畫布一下。',
    art: 'three-finger-tap',
    keywords: ['三指', '重做', '手勢', 'redo'],
  },
  {
    id: 'gesture-pinch', category: 'touch', title: '雙指捏合：縮放與旋轉',
    summary: '兩指張開／合起縮放，轉動兩指旋轉畫面，拖曳平移。',
    art: 'pinch',
    keywords: ['捏合', '縮放', '旋轉', '雙指', 'pinch', 'zoom'],
  },
  {
    id: 'gesture-long', category: 'touch', title: '長按：輪盤與多選',
    summary: '長按畫布叫出快捷輪盤；長按圖層進入多選或打開圖層選單。',
    art: 'long-press',
    keywords: ['長按', '輪盤', '快捷', '多選', 'long press', 'radial'],
  },

  // ---- 介面
  {
    id: 'docking', category: 'ui', title: '拖曳面板：停靠、浮動、合併',
    summary: '拖住面板標題就能移動：拖到畫面邊緣或其他面板之間停靠，拖到空白處變浮動視窗，拖到另一個浮動視窗上合併成分頁。',
    steps: ['把分頁拖出視窗即可分離', '浮動視窗四邊與四角都能調整大小', '雙擊標題列收合'],
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
    id: 'tablet-desktop', category: 'ui', title: '平板的桌面模式',
    summary: '觸控平板預設不浮動面板；「視窗 → 桌面模式」打開後就能像電腦一樣使用浮動視窗。',
    keywords: ['平板', 'ipad', 'dex', '桌面模式', '浮動'],
  },
  {
    id: 'tourbox', category: 'ui', title: '自訂快捷鍵與 TourBox',
    summary: '設定 → 快捷鍵，點按鍵即可重新綁定。最上方有 TourBox 對照表可直接複製。',
    keywords: ['自訂快捷鍵', '綁定', '按鍵', 'tourbox', 'shortcut', 'keybinding', '熱鍵'],
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
    keywords: ['匯出', '下載', '存檔', 'png', 'psd', 'photoshop', 'export', 'save'],
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
