/**
 * AtelierSync Customizable Keybinding & Shortcut Engine
 * Supports standard tools, tablet auxiliary expresskeys, single-key hotkeys, and combinations.
 */

import type { Language } from '../locales';
import { resolvePluginName, resolvePluginText } from '../plugins/pluginApi';
import type { InstalledPlugin } from '../plugins/pluginStore';

export type ShortcutCategory = 'toolbox' | 'layers' | 'filters' | 'studio' | 'actions' | 'navigation' | 'voice' | 'plugins';

export const makePluginCommandShortcutId = (pluginId: string, commandId: string) =>
  `plugin:${pluginId}:cmd:${commandId}`;

export const makePluginPanelShortcutId = (pluginId: string, panelId: string) =>
  `plugin:${pluginId}:panel:${panelId}`;

export const makePluginToolShortcutId = (pluginId: string, toolId: string) =>
  `plugin:${pluginId}:tool:${toolId}`;

export type ParsedPluginShortcutId =
  | { kind: 'command'; pluginId: string; commandId: string }
  | { kind: 'panel'; pluginId: string; panelId: string }
  | { kind: 'tool'; pluginId: string; toolId: string };

export function normalizeSuggestedShortcut(raw: string | undefined): string {
  if (!raw) return '';
  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  const key = parts[parts.length - 1];
  const rawMods = new Set(parts.slice(0, -1).map((m) => (m === 'Ctrl' ? 'Control' : m)));
  const ordered: string[] = [];
  for (const mod of ['Control', 'Meta', 'Alt', 'Shift']) {
    if (rawMods.has(mod)) ordered.push(mod);
  }
  ordered.push(key);
  return ordered.join('+');
}

export function parsePluginShortcutId(actionId: string): ParsedPluginShortcutId | null {
  if (!actionId.startsWith('plugin:')) return null;
  const cmdMarker = ':cmd:';
  const cmdIdx = actionId.lastIndexOf(cmdMarker);
  if (cmdIdx > 'plugin:'.length) {
    const pluginId = actionId.slice('plugin:'.length, cmdIdx);
    const commandId = actionId.slice(cmdIdx + cmdMarker.length);
    if (pluginId && commandId) return { kind: 'command', pluginId, commandId };
  }
  const panelMarker = ':panel:';
  const panelIdx = actionId.lastIndexOf(panelMarker);
  if (panelIdx > 'plugin:'.length) {
    const pluginId = actionId.slice('plugin:'.length, panelIdx);
    const panelId = actionId.slice(panelIdx + panelMarker.length);
    if (pluginId && panelId) return { kind: 'panel', pluginId, panelId };
  }
  const toolMarker = ':tool:';
  const toolIdx = actionId.lastIndexOf(toolMarker);
  if (toolIdx > 'plugin:'.length) {
    const pluginId = actionId.slice('plugin:'.length, toolIdx);
    const toolId = actionId.slice(toolIdx + toolMarker.length);
    if (pluginId && toolId) return { kind: 'tool', pluginId, toolId };
  }
  return null;
}

export interface ShortcutItem {
  id: string;
  category: ShortcutCategory;
  name: string;
  description: string;
  defaultCombo: string; // e.g. "KeyB", "Control+KeyZ", "F2", "BracketRight"
  currentCombo: string;
}

export const DEFAULT_SHORTCUTS: ShortcutItem[] = [
  // 1. Toolbox Tools (工具箱核心工具)
  {
    id: 'tool_brush',
    category: 'toolbox',
    name: '筆刷工具 (Brush)',
    description: '切換至自訂筆刷繪圖模式',
    defaultCombo: 'KeyB',
    currentCombo: 'KeyB',
  },
  {
    id: 'tool_pencil',
    category: 'toolbox',
    name: '鉛筆工具 (Pencil)',
    description: '切換至二值化硬邊鉛筆',
    defaultCombo: 'KeyP',
    currentCombo: 'KeyP',
  },
  {
    id: 'tool_eraser',
    category: 'toolbox',
    name: '橡皮擦 (Eraser)',
    description: '切換至即時透明擦除模式',
    defaultCombo: 'KeyE',
    currentCombo: 'KeyE',
  },
  {
    id: 'tool_eyedropper',
    category: 'toolbox',
    name: '吸色滴管 (Eyedropper)',
    description: '吸取畫布目前位置的像素顏色',
    defaultCombo: 'KeyI',
    currentCombo: 'KeyI',
  },
  {
    id: 'tool_bucket',
    category: 'toolbox',
    name: '油漆桶填色 (Paint Bucket)',
    description: '快速填滿封閉區域顏色',
    defaultCombo: 'KeyG',
    currentCombo: 'KeyG',
  },
  {
    id: 'tool_magic_wand',
    category: 'toolbox',
    name: '魔術棒 (Magic Wand)',
    description: '自動選取連續或全局相似色塊',
    defaultCombo: 'KeyW',
    currentCombo: 'KeyW',
  },
  {
    id: 'tool_lasso',
    category: 'toolbox',
    name: '自由套索 (Lasso)',
    description: '手繪自由多邊形封閉選區',
    defaultCombo: 'KeyL',
    currentCombo: 'KeyL',
  },
  {
    id: 'tool_smart_fill',
    category: 'toolbox',
    name: '智能填色 (Smart Enclose & Fill)',
    description: '套索圈選線稿區域自動閉合上色',
    defaultCombo: 'KeyF',
    currentCombo: 'KeyF',
  },
  {
    id: 'tool_vector_pen',
    category: 'toolbox',
    name: '向量鋼筆 (Vector Bézier Pen)',
    description: '繪製平滑三次貝茲曲線向量線稿',
    defaultCombo: 'KeyV',
    currentCombo: 'KeyV',
  },
  {
    id: 'tool_vector_reshape',
    category: 'toolbox',
    name: '向量節點修線 (Vector Reshape)',
    description: '捏合修線、節點拖曳與線寬動態加粗變細',
    defaultCombo: 'KeyY',
    currentCombo: 'KeyY',
  },
  {
    id: 'tool_hand',
    category: 'toolbox',
    name: '手形平移 (Hand / Pan)',
    description: '快速平移漫遊畫布視口',
    defaultCombo: 'KeyH',
    currentCombo: 'KeyH',
  },
  {
    id: 'tool_gradient',
    category: 'toolbox',
    name: '漸層工具 (Gradient)',
    description: '拖曳拉出線性或放射漸層',
    defaultCombo: 'Shift+KeyG',
    currentCombo: 'Shift+KeyG',
  },
  {
    id: 'tool_shape',
    category: 'toolbox',
    name: '形狀工具 (Shape)',
    description: '矩形、橢圓、直線與箭頭',
    defaultCombo: 'KeyU',
    currentCombo: 'KeyU',
  },
  {
    id: 'tool_text',
    category: 'toolbox',
    name: '文字工具 (Text)',
    description: '在畫布上放置文字',
    defaultCombo: 'KeyT',
    currentCombo: 'KeyT',
  },
  {
    id: 'tool_smudge',
    category: 'toolbox',
    name: '揉色 (Smudge)',
    description: '拖曳混合周圍顏色',
    defaultCombo: 'KeyR',
    currentCombo: 'KeyR',
  },
  {
    id: 'tool_blur',
    category: 'toolbox',
    name: '模糊 (Blur)',
    description: '局部模糊塗抹處',
    defaultCombo: 'Shift+KeyB',
    currentCombo: 'Shift+KeyB',
  },
  {
    id: 'tool_vector_bezier',
    category: 'toolbox',
    name: '鋼筆／連續曲線 (Bézier Pen)',
    description: '點擊放尖角節點、拖曳拉出平滑曲線',
    defaultCombo: 'Shift+KeyV',
    currentCombo: 'Shift+KeyV',
  },
  {
    id: 'tool_vector_edit',
    category: 'toolbox',
    name: '向量節點編輯 (Direct Selection)',
    description: '拖曳向量節點與控制桿、切換尖角／平滑',
    defaultCombo: 'KeyA',
    currentCombo: 'KeyA',
  },
  {
    id: 'tool_vector_width',
    category: 'toolbox',
    name: '向量線寬修正 (Vector Width)',
    description: '塗過的向量線段加粗或變細',
    defaultCombo: 'Shift+KeyW',
    currentCombo: 'Shift+KeyW',
  },
  {
    id: 'tool_vector_eraser',
    category: 'toolbox',
    name: '向量橡皮擦 (Vector Eraser)',
    description: '擦除向量線到交點或整條刪除',
    defaultCombo: 'Shift+KeyE',
    currentCombo: 'Shift+KeyE',
  },
  {
    id: 'tool_comic_balloon',
    category: 'toolbox',
    name: '對話氣泡 (Balloon)',
    description: '放置漫畫對話氣泡',
    defaultCombo: '',
    currentCombo: '',
  },
  {
    id: 'tool_comic_panel',
    category: 'toolbox',
    name: '漫畫分格 (Panel)',
    description: '拖曳切割漫畫分格',
    defaultCombo: 'KeyK',
    currentCombo: 'KeyK',
  },
  {
    id: 'tool_resize',
    category: 'toolbox',
    name: '調整畫布 (Resize Canvas)',
    description: '開啟畫布解析度與尺寸調整對話盒',
    defaultCombo: 'KeyC',
    currentCombo: 'KeyC',
  },

  // 2. Layer & Group Operations (圖層與圖層組管理)
  {
    id: 'action_layer_rename',
    category: 'layers',
    name: '重命名圖層 / 圖層組 (Rename)',
    description: '快速就地修改當前選中圖層或圖層組名稱 (同 F2 / 雙擊)',
    defaultCombo: 'F2',
    currentCombo: 'F2',
  },
  {
    id: 'action_layer_new_raster',
    category: 'layers',
    name: '新建點陣圖層 (New Raster Layer)',
    description: '在當前選擇圖層上方建立點陣圖層並直接開始繪畫',
    defaultCombo: 'Control+Shift+KeyN',
    currentCombo: 'Control+Shift+KeyN',
  },
  {
    id: 'action_layer_new_vector',
    category: 'layers',
    name: '新建向量線稿圖層 (New Vector Layer)',
    description: '在當前選擇圖層上方建立向量線稿圖層 (具備修線與交點消除)',
    defaultCombo: 'Control+Alt+KeyN',
    currentCombo: 'Control+Alt+KeyN',
  },
  {
    id: 'action_layer_new_group',
    category: 'layers',
    name: '群組圖層 (Group Layers)',
    description: '把選取的圖層（沒有多選時是目前圖層）放進新的圖層組；只能群組自己的圖層',
    defaultCombo: 'Control+KeyG',
    currentCombo: 'Control+KeyG',
  },
  {
    id: 'action_layer_merge_down',
    category: 'layers',
    name: '向下合併 (Merge Down)',
    description: '把目前圖層合併到下面一層；兩層都要是自己的圖層',
    defaultCombo: 'Control+KeyE',
    currentCombo: 'Control+KeyE',
  },
  {
    id: 'action_layer_copy',
    category: 'layers',
    name: '複製圖層 (Copy Layer)',
    description: '把目前圖層（含蒙版、圖層組內容）記起來，可以貼到這張或其他畫布',
    defaultCombo: 'Control+Alt+KeyC',
    currentCombo: 'Control+Alt+KeyC',
  },
  {
    id: 'action_layer_paste',
    category: 'layers',
    name: '貼上圖層 (Paste Layer)',
    description: '把複製的圖層貼成新圖層，放在目前圖層上方（貼上的是你的圖層）',
    defaultCombo: 'Control+Alt+KeyV',
    currentCombo: 'Control+Alt+KeyV',
  },
  {
    id: 'action_layer_duplicate',
    category: 'layers',
    name: '製作圖層副本 (Duplicate Layer)',
    description: '複製並馬上貼上目前圖層',
    defaultCombo: 'Control+KeyJ',
    currentCombo: 'Control+KeyJ',
  },
  {
    id: 'action_layer_toggle_clip',
    category: 'layers',
    name: '切換剪裁遮罩 (Toggle Clipping Mask)',
    description: '切換以下方圖層為剪裁遮罩 (依下方圖層形狀剪裁)',
    defaultCombo: 'Control+Alt+KeyG',
    currentCombo: 'Control+Alt+KeyG',
  },
  {
    id: 'action_layer_toggle_alpha',
    category: 'layers',
    name: '切換鎖定透明度 (Toggle Alpha Lock)',
    description: '鎖定透明度保護，僅在已有畫筆像素上作畫 (🔒α)',
    defaultCombo: 'Slash',
    currentCombo: 'Slash',
  },
  {
    id: 'action_layer_toggle_vis',
    category: 'layers',
    name: '切換圖層可見度 (Toggle Visibility)',
    description: '隱藏或顯示當前選中的圖層',
    defaultCombo: 'Control+Comma',
    currentCombo: 'Control+Comma',
  },
  {
    id: 'action_layer_toggle_lock',
    category: 'layers',
    name: '切換圖層鎖定 (Toggle Layer Lock)',
    description: '防止誤觸修改當前圖層',
    defaultCombo: 'Control+KeyL',
    currentCombo: 'Control+KeyL',
  },
  {
    id: 'action_layer_move_up',
    category: 'layers',
    name: '向上移一層 (Move Layer Up)',
    description: '將當前圖層在圖層樹中向上提升一層',
    defaultCombo: 'Control+BracketRight',
    currentCombo: 'Control+BracketRight',
  },
  {
    id: 'action_layer_move_down',
    category: 'layers',
    name: '向下移一層 (Move Layer Down)',
    description: '將當前圖層在圖層樹中向下降低一層',
    defaultCombo: 'Control+BracketLeft',
    currentCombo: 'Control+BracketLeft',
  },
  {
    id: 'action_layer_select_above',
    category: 'layers',
    name: '選擇上一層圖層 (Select Layer Above)',
    description: '將作畫焦點切換至上方圖層',
    defaultCombo: 'Alt+BracketRight',
    currentCombo: 'Alt+BracketRight',
  },
  {
    id: 'action_layer_select_below',
    category: 'layers',
    name: '選擇下一層圖層 (Select Layer Below)',
    description: '將作畫焦點切換至下方圖層',
    defaultCombo: 'Alt+BracketLeft',
    currentCombo: 'Alt+BracketLeft',
  },
  {
    id: 'action_layer_delete',
    category: 'layers',
    name: '刪除當前圖層 (Delete Layer)',
    description: '刪除目前選中的圖層或圖層組（Delete 單鍵留給清除選取內容，避免誤刪整層）',
    defaultCombo: 'Control+Delete',
    currentCombo: 'Control+Delete',
  },

  // 3. Color & Advanced Filters (調色與專業濾鏡)
  {
    id: 'action_filter_curves',
    category: 'filters',
    name: 'RGB / 亮度色階曲線 (Color Curves)',
    description: '開啟貝茲曲線色階調節器 (支援 RGB / 各通道直方圖)',
    defaultCombo: 'Control+KeyM',
    currentCombo: 'Control+KeyM',
  },
  {
    id: 'action_filter_gradient_map',
    category: 'filters',
    name: '漸層對應濾鏡 (Gradient Map)',
    description: '套用日落、賽博龐克、水墨等高階漸層對應',
    defaultCombo: 'Control+Alt+KeyM',
    currentCombo: 'Control+Alt+KeyM',
  },
  {
    id: 'action_filter_liquify',
    category: 'filters',
    name: '液化筆刷 (Liquify Filter)',
    description: 'GPU WebGL 高速網格推抹液化微調五官與形體',
    defaultCombo: 'Control+Shift+KeyX',
    currentCombo: 'Control+Shift+KeyX',
  },
  {
    id: 'action_filter_mesh_warp',
    category: 'filters',
    name: '網格變形 (Mesh Warp)',
    description: '自由網格節點非線性幾何扭曲',
    defaultCombo: 'Control+Shift+KeyT',
    currentCombo: 'Control+Shift+KeyT',
  },
  {
    id: 'action_filter_free_transform',
    category: 'filters',
    name: '自由變形 (Free Transform)',
    description: '縮放、等比拉伸、旋轉當前選區或圖層',
    defaultCombo: 'Control+KeyT',
    currentCombo: 'Control+KeyT',
  },
  {
    id: 'action_filter_screentone',
    category: 'filters',
    name: '切換漫畫網點 (Toggle Screentone)',
    description: '切換當前圖層即時 GPU 半色調漫畫黑白網點',
    defaultCombo: 'Control+Alt+KeyS',
    currentCombo: 'Control+Alt+KeyS',
  },

  // 4. Creative Studio & Auxiliary Views (創作工作室與輔助工具)
  {
    id: 'action_studio_ruler',
    category: 'studio',
    name: '透視與對稱尺規 (Ruler Controls)',
    description: '開啟兩點透視、三點透視、同心圓與多軸鏡像對稱尺規',
    defaultCombo: 'Control+KeyR',
    currentCombo: 'Control+KeyR',
  },
  {
    id: 'action_studio_timeline',
    category: 'studio',
    name: '逐幀動畫時間軸 (Animation Timeline)',
    description: '開啟手繪手翻動畫時間軸與洋蔥皮播放器',
    defaultCombo: 'Control+Shift+KeyA',
    currentCombo: 'Control+Shift+KeyA',
  },
  {
    id: 'action_studio_comic',
    category: 'studio',
    name: '漫畫分鏡與氣泡 (Comic Studio)',
    description: '多格漫畫分鏡切割、對話氣泡拖曳與文字編輯',
    defaultCombo: 'Control+Shift+KeyK',
    currentCombo: 'Control+Shift+KeyK',
  },
  {
    id: 'action_studio_history',
    category: 'studio',
    name: '時光膠囊回放 (Time Capsule)',
    description: '畫布歷史錄影高倍速縮時攝影播放',
    defaultCombo: 'Control+Shift+KeyH',
    currentCombo: 'Control+Shift+KeyH',
  },
  {
    id: 'action_studio_color_wheel',
    category: 'studio',
    name: 'HSV 專業調色盤 (Color Wheel Studio)',
    description: '開啟 HSV 專業色輪工作室與混色盤',
    defaultCombo: 'KeyS',
    currentCombo: 'KeyS',
  },

  // 5. Actions & Operations (繪圖操作與局部歷程)
  {
    id: 'action_undo',
    category: 'actions',
    name: '局部撤銷 (Scoped Undo)',
    description: '僅撤銷當前用戶在自身圖層的操作 (不影響其他畫友)',
    defaultCombo: 'Control+KeyZ',
    currentCombo: 'Control+KeyZ',
  },
  {
    id: 'action_redo',
    category: 'actions',
    name: '重做 (Redo)',
    description: '恢復剛撤銷的繪畫步驟',
    defaultCombo: 'Control+KeyY',
    currentCombo: 'Control+KeyY',
  },
  {
    id: 'action_clear_selection',
    category: 'actions',
    name: '取消選區 (Deselect)',
    description: '清除畫布上當前活動螞蟻線選區',
    defaultCombo: 'Control+KeyD',
    currentCombo: 'Control+KeyD',
  },
  {
    id: 'action_selection_invert',
    category: 'actions',
    name: '反選 (Invert Selection)',
    description: '改選取目前範圍以外的部分；沒有選取時為全選',
    defaultCombo: 'Control+Shift+KeyI',
    currentCombo: 'Control+Shift+KeyI',
  },
  {
    id: 'action_selection_copy',
    category: 'actions',
    name: '複製選取內容 (Copy)',
    description: '複製目前圖層在選取範圍內的像素',
    defaultCombo: 'Control+KeyC',
    currentCombo: 'Control+KeyC',
  },
  {
    id: 'action_selection_cut',
    category: 'actions',
    name: '剪下選取內容 (Cut)',
    description: '複製並清除目前圖層在選取範圍內的像素',
    defaultCombo: 'Control+KeyX',
    currentCombo: 'Control+KeyX',
  },
  {
    id: 'action_selection_paste',
    category: 'actions',
    name: '貼上 (Paste)',
    description: '把複製的內容貼回原位置，可拖動調整後按 Enter 確定',
    defaultCombo: 'Control+KeyV',
    currentCombo: 'Control+KeyV',
  },
  {
    id: 'action_selection_delete',
    category: 'actions',
    name: '清除選取內容 (Clear)',
    description: '清除目前圖層在選取範圍內的像素',
    defaultCombo: 'Delete',
    currentCombo: 'Delete',
  },
  {
    id: 'action_brush_larger',
    category: 'actions',
    name: '增大筆刷尺寸 (下一級)',
    description: '依尺寸級距放大目前工具的筆刷直徑',
    defaultCombo: 'BracketRight',
    currentCombo: 'BracketRight',
  },
  {
    id: 'action_brush_smaller',
    category: 'actions',
    name: '縮小筆刷尺寸 (上一級)',
    description: '依尺寸級距縮小目前工具的筆刷直徑',
    defaultCombo: 'BracketLeft',
    currentCombo: 'BracketLeft',
  },

  // 6. Navigation & Floating Panels (視圖與導航)
  {
    id: 'action_toggle_tools',
    category: 'navigation',
    name: '切換工具箱面板',
    description: '快速隱藏或顯示左側工具箱',
    defaultCombo: 'Tab',
    currentCombo: 'Tab',
  },
  {
    id: 'action_reset_view',
    category: 'navigation',
    name: '重置視口 (100% 居中)',
    description: '將畫布縮放重設為 100% 並置中',
    defaultCombo: 'Digit0',
    currentCombo: 'Digit0',
  },
  {
    id: 'action_zoom_in',
    category: 'navigation',
    name: '放大畫布視口 (Zoom In)',
    description: '將畫布視角平滑放大',
    defaultCombo: 'Equal',
    currentCombo: 'Equal',
  },
  {
    id: 'action_zoom_out',
    category: 'navigation',
    name: '縮小畫布視口 (Zoom Out)',
    description: '將畫布視角平滑縮小',
    defaultCombo: 'Minus',
    currentCombo: 'Minus',
  },
  // Made for rotary / button controllers (TourBox): every step is one key press, repeats freely
  {
    id: 'action_view_rotate_left',
    category: 'navigation',
    name: '畫布向左旋轉 (Rotate View Left)',
    description: '畫面逆時針轉 15°（只轉你的視角，不改圖）；適合 TourBox 轉盤',
    defaultCombo: 'Shift+BracketLeft',
    currentCombo: 'Shift+BracketLeft',
  },
  {
    id: 'action_view_rotate_right',
    category: 'navigation',
    name: '畫布向右旋轉 (Rotate View Right)',
    description: '畫面順時針轉 15°；適合 TourBox 轉盤',
    defaultCombo: 'Shift+BracketRight',
    currentCombo: 'Shift+BracketRight',
  },
  {
    id: 'action_view_flip',
    category: 'navigation',
    name: '左右翻轉畫面 (Flip View)',
    description: '鏡像檢查構圖（只翻你的視角，不改圖）',
    defaultCombo: 'Shift+KeyF',
    currentCombo: 'Shift+KeyF',
  },
  {
    id: 'action_brush_opacity_up',
    category: 'actions',
    name: '筆刷不透明度 +5% (Opacity Up)',
    description: '每按一次 +5%；適合 TourBox 旋鈕',
    defaultCombo: 'Shift+Equal',
    currentCombo: 'Shift+Equal',
  },
  {
    id: 'action_brush_opacity_down',
    category: 'actions',
    name: '筆刷不透明度 −5% (Opacity Down)',
    description: '每按一次 −5%；適合 TourBox 旋鈕',
    defaultCombo: 'Shift+Minus',
    currentCombo: 'Shift+Minus',
  },
  {
    id: 'action_anim_prev_frame',
    category: 'studio',
    name: '動畫：上一格 (Previous Frame)',
    description: '時間軸往前一格（只在你的畫面）',
    defaultCombo: 'Comma',
    currentCombo: 'Comma',
  },
  {
    id: 'action_anim_next_frame',
    category: 'studio',
    name: '動畫：下一格 (Next Frame)',
    description: '時間軸往後一格（只在你的畫面）',
    defaultCombo: 'Period',
    currentCombo: 'Period',
  },
  {
    id: 'action_anim_play',
    category: 'studio',
    name: '動畫：播放／暫停 (Play / Pause)',
    description: '播放或暫停動畫（只在你的畫面）',
    defaultCombo: 'Shift+Period',
    currentCombo: 'Shift+Period',
  },
  {
    id: 'action_anim_onion',
    category: 'studio',
    name: '動畫：洋蔥皮開關 (Onion Skin)',
    description: '顯示或隱藏前後格的洋蔥皮',
    defaultCombo: 'KeyO',
    currentCombo: 'KeyO',
  },
  {
    id: 'action_anim_add_cel',
    category: 'studio',
    name: '動畫：新增膠片 (Add Cel)',
    description: '在目前時間軸位置新增一張賽璐珞格',
    defaultCombo: 'Alt+KeyN',
    currentCombo: 'Alt+KeyN',
  },
  {
    id: 'action_anim_add_blank',
    category: 'studio',
    name: '動畫：新增空白格 (Blank Frame)',
    description: '在目前時間軸位置插入一個空白格',
    defaultCombo: 'Alt+KeyB',
    currentCombo: 'Alt+KeyB',
  },
  {
    id: 'action_anim_first_frame',
    category: 'studio',
    name: '動畫：跳至最前格 (First Frame)',
    description: '將播放頭移至第一格（或播放範圍起點）',
    defaultCombo: 'Shift+Comma',
    currentCombo: 'Shift+Comma',
  },
  {
    id: 'action_anim_last_frame',
    category: 'studio',
    name: '動畫：跳至最後格 (Last Frame)',
    description: '將播放頭移至最後一格（或播放範圍終點）',
    defaultCombo: 'Alt+Period',
    currentCombo: 'Alt+Period',
  },
  {
    id: 'action_anim_prev_keyframe',
    category: 'studio',
    name: '動畫：上一個關鍵影格 (Prev Keyframe)',
    description: '跳到目前格之前的上一個關鍵影格',
    defaultCombo: 'Alt+Comma',
    currentCombo: 'Alt+Comma',
  },
  {
    id: 'action_anim_next_keyframe',
    category: 'studio',
    name: '動畫：下一個關鍵影格 (Next Keyframe)',
    description: '跳到目前格之後的下一個關鍵影格',
    defaultCombo: 'Alt+Slash',
    currentCombo: 'Alt+Slash',
  },
  {
    id: 'action_anim_flip',
    category: 'studio',
    name: '動畫：手翻書（按住翻看） (Flipbook)',
    description: '按住時於前後數張之間來回翻看，放開回到原格',
    defaultCombo: 'Backquote',
    currentCombo: 'Backquote',
  },

  // 7. Voice Chat (WebRTC 即時語音)
  {
    id: 'action_toggle_mic',
    category: 'voice',
    name: '語音麥克風靜音開關',
    description: '快速切換 WebRTC 即時通話靜音',
    defaultCombo: 'KeyM',
    currentCombo: 'KeyM',
  },
];

const STORAGE_KEY = 'atelier_custom_shortcuts';
// Former defaults that changed: a saved copy of one of these takes the new default instead
const RETIRED_DEFAULTS: Record<string, string> = { action_layer_delete: 'Delete' };

/** Keys a browser tab never receives (Chrome / Edge / Firefox act on them first); the desktop app gets them all */
const BROWSER_RESERVED = new Set([
  'Control+KeyT', 'Control+KeyN', 'Control+KeyW', 'Control+Shift+KeyT', 'Control+Shift+KeyN', 'Control+Shift+KeyW',
  'Control+Tab', 'Control+Shift+Tab', 'Control+PageUp', 'Control+PageDown', 'Control+Shift+PageUp', 'Control+Shift+PageDown',
  'Control+Shift+KeyI', 'Control+Shift+KeyJ', 'Control+Shift+KeyC', 'Control+Shift+Delete', 'F11', 'F12', 'Alt+F4',
]);
/** In a browser, actions whose desktop default the browser keeps get these instead (Photopea does the same: Ctrl+Alt+T) */
const BROWSER_DEFAULTS: Record<string, string> = {
  action_filter_free_transform: 'Control+Alt+KeyT',
  action_filter_mesh_warp: 'Control+Alt+Shift+KeyT',
  action_layer_new_raster: 'Control+Alt+Shift+KeyN',
  action_selection_invert: 'Control+Alt+KeyI',
};
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
const inDesktopApp = () => typeof window !== 'undefined' && Boolean((window as { atelierDesktop?: { isElectron?: boolean } }).atelierDesktop?.isElectron);
/** The defaults where this runs: in a browser, none the browser keeps for itself */
const defaultShortcuts = (): ShortcutItem[] =>
  DEFAULT_SHORTCUTS.map((s) => {
    const combo = !inDesktopApp() && BROWSER_DEFAULTS[s.id] ? BROWSER_DEFAULTS[s.id] : s.defaultCombo;
    return { ...s, defaultCombo: combo, currentCombo: combo };
  });

export class ShortcutManager {
  private static instance: ShortcutManager | null = null;
  private shortcuts: ShortcutItem[] = [];
  private pluginShortcuts: ShortcutItem[] = [];
  private savedPluginCombos = new Map<string, string>();
  private lastPluginSync: { plugins: readonly InstalledPlugin[]; language?: Language } | null = null;
  private listeners = new Set<() => void>();

  private constructor() {
    this.load();
  }

  public static getInstance(): ShortcutManager {
    if (!ShortcutManager.instance) {
      ShortcutManager.instance = new ShortcutManager();
    }
    return ShortcutManager.instance;
  }

  public getShortcuts(): ShortcutItem[] {
    return [...this.shortcuts, ...this.pluginShortcuts];
  }

  public getPluginShortcuts(): ShortcutItem[] {
    return [...this.pluginShortcuts];
  }

  public getComboForAction(actionId: string): string {
    const item = this.shortcuts.find((s) => s.id === actionId) ?? this.pluginShortcuts.find((s) => s.id === actionId);
    return item ? item.currentCombo : '';
  }

  /**
   * Synchronizes dynamic plugin shortcuts from enabled plugins.
   * Anti-hijack rule: `suggestedShortcut` is only accepted when no user override exists AND it
   * neither hits a browser-reserved combo nor conflicts with any built-in or already-occupied binding;
   * otherwise it degrades cleanly to unbound ('').
   */
  public syncPluginShortcuts(plugins: readonly InstalledPlugin[], language?: Language): void {
    this.lastPluginSync = { plugins: [...plugins], language };
    const occupied = new Set<string>();
    for (const s of this.shortcuts) {
      if (s.currentCombo) occupied.add(s.currentCombo.toLowerCase());
    }

    type Candidate = {
      id: string;
      name: string;
      description: string;
      suggested: string;
    };
    const candidates: Candidate[] = [];
    for (const entry of plugins) {
      if (!entry.enabled) continue;
      const { manifest } = entry;
      const pluginName = resolvePluginName(manifest, language ?? 'en-US');
      if (manifest.apiVersion === 2) {
        if (manifest.permissions.includes('ui:panel')) {
          for (const panel of manifest.panels) {
            const title = resolvePluginText(panel.title, panel.i18nTitle, language ?? 'en-US');
            candidates.push({
              id: makePluginPanelShortcutId(manifest.id, panel.id),
              name: `${pluginName} · ${title}`,
              description: pluginName,
              suggested: '',
            });
          }
        }
        if (manifest.permissions.includes('commands')) {
          for (const cmd of manifest.commands) {
            const label = resolvePluginText(cmd.label, cmd.i18nLabel, language ?? 'en-US');
            candidates.push({
              id: makePluginCommandShortcutId(manifest.id, cmd.id),
              name: `${pluginName} · ${label}`,
              description: cmd.group ? `${pluginName} · ${cmd.group}` : pluginName,
              suggested: normalizeSuggestedShortcut(cmd.suggestedShortcut),
            });
          }
        }
        if (manifest.permissions.includes('tools') && manifest.tools?.length) {
          for (const tool of manifest.tools) {
            const label = resolvePluginText(tool.label, tool.i18nLabel, language ?? 'en-US');
            candidates.push({
              id: makePluginToolShortcutId(manifest.id, tool.id),
              name: `${pluginName} · ${label}`,
              description: pluginName,
              suggested: normalizeSuggestedShortcut(tool.suggestedShortcut),
            });
          }
        }
      } else {
        for (const cmd of manifest.commands) {
          candidates.push({
            id: makePluginCommandShortcutId(manifest.id, cmd.id),
            name: `${pluginName} · ${cmd.label}`,
            description: pluginName,
            suggested: '',
          });
        }
      }
    }

    // Reserve any user-saved plugin bindings first so suggested shortcuts from other plugins cannot collide with them
    for (const c of candidates) {
      if (this.savedPluginCombos.has(c.id)) {
        const saved = this.savedPluginCombos.get(c.id) ?? '';
        if (saved) occupied.add(saved.toLowerCase());
      }
    }

    const next: ShortcutItem[] = [];
    for (const c of candidates) {
      let safeDefault = '';
      if (c.suggested && !ShortcutManager.isBrowserReserved(c.suggested) && !occupied.has(c.suggested.toLowerCase())) {
        safeDefault = c.suggested;
      }
      let currentCombo: string;
      if (this.savedPluginCombos.has(c.id)) {
        currentCombo = this.savedPluginCombos.get(c.id) ?? '';
      } else {
        currentCombo = safeDefault;
        if (currentCombo) occupied.add(currentCombo.toLowerCase());
      }
      next.push({
        id: c.id,
        category: 'plugins',
        name: c.name,
        description: c.description,
        defaultCombo: safeDefault,
        currentCombo,
      });
    }

    this.pluginShortcuts = next;
    this.notify();
  }

  /** Finds the first bound plugin shortcut matching this KeyboardEvent (checked after built-in shortcuts). */
  public findPluginActionForEvent(ev: KeyboardEvent): ParsedPluginShortcutId | null {
    for (const item of this.pluginShortcuts) {
      if (item.currentCombo && this.matchesEvent(item.currentCombo, ev)) {
        return parsePluginShortcutId(item.id);
      }
    }
    return null;
  }

  public getDisplayLabel(combo: string): string {
    if (!combo) return '';
    return combo
      .replace(/^Control$/, 'Ctrl')
      .replace(/^Meta$/, 'Cmd')
      .replace('Control+', 'Ctrl+')
      .replace('Meta+', 'Cmd+')
      .replace('Shift+', 'Shift+')
      .replace('Alt+', 'Alt+')
      .replace('Key', '')
      .replace('Digit', '')
      .replace('BracketRight', ']')
      .replace('BracketLeft', '[')
      .replace('Minus', '-')
      .replace('Equal', '=')
      .replace('Comma', ',')
      .replace('Period', '.')
      .replace('Slash', '/')
      .replace('Backslash', '\\')
      .replace('Semicolon', ';')
      .replace('Quote', "'")
      .replace('Backquote', '`');
  }

  public setShortcut(actionId: string, newCombo: string) {
    const builtin = this.shortcuts.find((s) => s.id === actionId);
    if (builtin) {
      builtin.currentCombo = newCombo;
      this.save();
      this.notify();
      return;
    }
    const pluginItem = this.pluginShortcuts.find((s) => s.id === actionId);
    if (pluginItem) {
      pluginItem.currentCombo = newCombo;
      this.savedPluginCombos.set(actionId, newCombo);
      this.save();
      this.notify();
    }
  }

  public resetToDefaults() {
    this.shortcuts = defaultShortcuts();
    this.savedPluginCombos.clear();
    if (this.lastPluginSync) {
      this.syncPluginShortcuts(this.lastPluginSync.plugins, this.lastPluginSync.language);
    }
    this.save();
    this.notify();
  }

  public subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify() {
    for (const cb of this.listeners) {
      cb();
    }
  }

  private save() {
    if (typeof localStorage === 'undefined') return;
    try {
      const data: Array<{ id: string; currentCombo: string }> = [
        ...this.shortcuts.map(({ id, currentCombo }) => ({ id, currentCombo })),
        ...Array.from(this.savedPluginCombos.entries()).map(([id, currentCombo]) => ({ id, currentCombo })),
      ];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('Failed to save shortcuts to localStorage:', err);
    }
  }

  private load() {
    this.shortcuts = defaultShortcuts();
    this.savedPluginCombos.clear();
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved: Array<{ id: string; currentCombo: string }> = JSON.parse(raw);
        for (const item of saved) {
          if (typeof item?.id !== 'string' || typeof item.currentCombo !== 'string') continue;
          if (item.id.startsWith('plugin:')) {
            this.savedPluginCombos.set(item.id, item.currentCombo);
            continue;
          }
          const match = this.shortcuts.find((s) => s.id === item.id);
          // save() also stores untouched defaults: a retired default is not a user choice
          if (RETIRED_DEFAULTS[item.id] === item.currentCombo) continue;
          // Nor is a key the browser keeps, where this action has a browser default
          if (BROWSER_DEFAULTS[item.id] && ShortcutManager.isBrowserReserved(item.currentCombo)) continue;
          if (match && item.currentCombo) {
            match.currentCombo = item.currentCombo;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load shortcuts from localStorage:', err);
    }
  }

  /**
   * Normalize a native KeyboardEvent into a combo string, e.g. "Control+KeyZ" or "KeyB"
   */
  public static eventToCombo(ev: KeyboardEvent): string {
    const parts: string[] = [];
    if (ev.ctrlKey) parts.push('Control');
    if (ev.metaKey) parts.push('Meta');
    if (ev.altKey) parts.push('Alt');
    if (ev.shiftKey) parts.push('Shift');

    // Filter out modifier keys themselves as the main code
    if (!ShortcutManager.isModifierCode(ev.code) && ev.code) {
      parts.push(ev.code);
    }

    return parts.join('+');
  }

  /** Shift, Ctrl, Alt or ⌘ on its own (a combo is still being pressed) */
  public static isModifierCode(code: string): boolean {
    return MODIFIER_CODES.has(code);
  }

  /** A key a browser tab never receives (always false in the desktop app) */
  public static isBrowserReserved(combo: string): boolean {
    return !inDesktopApp() && BROWSER_RESERVED.has(combo);
  }

  /**
   * Matches an event against a combo string
   */
  public matchesEvent(combo: string, ev: KeyboardEvent): boolean {
    if (!combo) return false;
    const evCombo = ShortcutManager.eventToCombo(ev);
    return combo.toLowerCase() === evCombo.toLowerCase();
  }
}
