import React from 'react';
import { ToolType } from '@atelier/shared';
import type { Translations } from '../../locales';
import {
  Activity,
  CircleDashed,
  Highlighter,
  Blend,
  Columns,
  Droplets,
  Eraser,
  Film,
  Hand,
  Lasso,
  MessageCircle,
  Minus,
  Move,
  MousePointer2,
  Paintbrush,
  PaintBucket,
  PenTool,
  Pencil,
  Pipette,
  Sparkles,
  Spline,
  Square,
  Type,
  Wand2,
  Waves,
  Wind,
} from 'lucide-react';

export interface ToolDef {
  id: ToolType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** ShortcutManager action id whose combo selects this tool */
  shortcutId?: string;
  /** One line shown in the tooltip and the options bar */
  hint: string;
}

export interface ToolGroup {
  id: string;
  label: string;
  tools: ToolDef[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'paint',
    label: '繪畫',
    tools: [
      { id: 'brush', label: '筆刷', icon: Paintbrush, shortcutId: 'tool_brush', hint: '感壓筆刷。[ ] 調整大小' },
      { id: 'pencil', label: '鉛筆', icon: Pencil, shortcutId: 'tool_pencil', hint: '硬邊鉛筆，適合線稿' },
      { id: 'eraser', label: '橡皮擦', icon: Eraser, shortcutId: 'tool_eraser', hint: '擦除目前圖層' },
      { id: 'blur', label: '模糊', icon: Wind, shortcutId: 'tool_blur', hint: '塗抹處局部模糊' },
      { id: 'smudge', label: '揉色', icon: Droplets, shortcutId: 'tool_smudge', hint: '拖曳混合周圍顏色' },
    ],
  },
  {
    id: 'fill',
    label: '填色',
    tools: [
      { id: 'bucket', label: '油漆桶', icon: PaintBucket, shortcutId: 'tool_bucket', hint: '點擊填滿封閉區域；上方選項可切換成「套索填色」' },
      { id: 'smart_fill', label: '智能填色', icon: Sparkles, shortcutId: 'tool_smart_fill', hint: '圈住線稿區域自動上色' },
      { id: 'gradient', label: '漸層', icon: Blend, shortcutId: 'tool_gradient', hint: '拖曳拉出漸層' },
      { id: 'eyedropper', label: '滴管', icon: Pipette, shortcutId: 'tool_eyedropper', hint: '點擊吸取顏色（任何工具按住 Alt 亦可）' },
    ],
  },
  {
    id: 'select',
    label: '選取與變形',
    tools: [
      { id: 'lasso', label: '套索選取', icon: Lasso, shortcutId: 'tool_lasso', hint: '拖曳圈選；Shift 加選、Ctrl 減選' },
      { id: 'magic_wand', label: '魔術棒', icon: Wand2, shortcutId: 'tool_magic_wand', hint: '點擊選取相近顏色；Shift 加選、Ctrl 減選' },
      { id: 'select_brush', label: '選取筆', icon: Highlighter, hint: '用畫的加入選取範圍（筆刷大小＝筆尖大小）' },
      { id: 'select_eraser', label: '選取橡皮擦', icon: CircleDashed, hint: '用畫的從選取範圍挖掉' },
      { id: 'transform', label: '自由變形', icon: Move, shortcutId: 'action_filter_free_transform', hint: '有選區時變形選區，否則變形圖層上有內容的範圍' },
      { id: 'liquify', label: '液化', icon: Waves, shortcutId: 'action_filter_liquify', hint: '推拉、膨脹、縮小或旋轉像素' },
      { id: 'hand', label: '抓手', icon: Hand, shortcutId: 'tool_hand', hint: '拖曳移動畫面（任何工具按住空白鍵亦可）' },
    ],
  },
  {
    id: 'vector',
    label: '向量',
    tools: [
      { id: 'vector_pen', label: '向量筆', icon: Spline, shortcutId: 'tool_vector_pen', hint: '徒手畫向量線，之後可修線' },
      { id: 'vector_bezier', label: '鋼筆／曲線', icon: PenTool, shortcutId: 'tool_vector_bezier', hint: '點擊放尖角、拖曳拉出平滑曲線；Enter 或雙擊完成' },
      { id: 'vector_edit', label: '節點編輯', icon: MousePointer2, shortcutId: 'tool_vector_edit', hint: '拖曳節點與控制桿；雙擊節點切換尖角／平滑；Delete 刪除節點' },
      { id: 'vector_reshape', label: '捏線', icon: Activity, shortcutId: 'tool_vector_reshape', hint: '在筆刷範圍內拖曳整段拉動線條' },
      { id: 'vector_width', label: '線寬修正', icon: Minus, shortcutId: 'tool_vector_width', hint: '塗過的線段加粗或變細' },
      { id: 'vector_eraser', label: '向量橡皮擦', icon: Eraser, shortcutId: 'tool_vector_eraser', hint: '擦到交點為止或整條刪除，只動線條不動底色' },
    ],
  },
  {
    id: 'create',
    label: '形狀與漫畫',
    tools: [
      { id: 'shape', label: '形狀', icon: Square, shortcutId: 'tool_shape', hint: '拖曳畫矩形、橢圓、直線、箭頭；Shift 等比' },
      { id: 'text', label: '文字', icon: Type, shortcutId: 'tool_text', hint: '點擊畫布輸入文字' },
      { id: 'comic_balloon', label: '對話氣泡', icon: MessageCircle, shortcutId: 'tool_comic_balloon', hint: '放置漫畫對話氣泡' },
      { id: 'comic_panel', label: '漫畫分格', icon: Columns, shortcutId: 'tool_comic_panel', hint: '拖曳切割分格' },
      { id: 'animation', label: '動畫', icon: Film, shortcutId: 'action_studio_timeline', hint: '開啟逐格動畫時間軸' },
    ],
  },
];

export const ALL_TOOLS: ToolDef[] = TOOL_GROUPS.flatMap((g) => g.tools);

export const findTool = (id: ToolType): ToolDef | undefined => ALL_TOOLS.find((t) => t.id === id);

export const getLocalizedTool = (id: ToolType, t: Translations): { label: string; hint: string } => {
  switch (id) {
    case 'brush': return { label: t.tools.brush, hint: t.tools.brushHint };
    case 'pencil': return { label: t.tools.pencil, hint: t.tools.pencilHint };
    case 'eraser': return { label: t.tools.eraser, hint: t.tools.eraserHint };
    case 'blur': return { label: t.tools.blur, hint: t.tools.blurHint };
    case 'smudge': return { label: t.tools.smudge, hint: t.tools.smudgeHint };
    case 'bucket': return { label: t.tools.bucket, hint: t.tools.bucketHint };
    case 'smart_fill': return { label: t.tools.smartFill, hint: t.tools.smartFillHint };
    case 'gradient': return { label: t.tools.gradient, hint: t.tools.gradientHint };
    case 'eyedropper': return { label: t.tools.eyedropper, hint: t.tools.eyedropperHint };
    case 'lasso': return { label: t.tools.lasso, hint: t.tools.lassoHint };
    case 'magic_wand': return { label: t.tools.magicWand, hint: t.tools.magicWandHint };
    case 'select_brush': return { label: t.tools.selectBrush, hint: t.tools.selectBrushHint };
    case 'select_eraser': return { label: t.tools.selectEraser, hint: t.tools.selectEraserHint };
    case 'transform': return { label: t.tools.transform, hint: t.tools.transformHint };
    case 'mesh_warp': return { label: t.tools.meshWarp, hint: t.tools.transformHint };
    case 'liquify': return { label: t.tools.liquify, hint: t.tools.liquifyHint };
    case 'hand': return { label: t.tools.hand, hint: t.tools.handHint };
    case 'vector_pen': return { label: t.tools.vectorPen, hint: t.tools.vectorPenHint };
    case 'vector_bezier': return { label: t.tools.vectorBezier, hint: t.tools.vectorBezierHint };
    case 'vector_edit': return { label: t.tools.vectorEdit, hint: t.tools.vectorEditHint };
    case 'vector_reshape': return { label: t.tools.vectorReshape, hint: t.tools.vectorReshapeHint };
    case 'vector_width': return { label: t.tools.vectorWidth, hint: t.tools.vectorWidthHint };
    case 'vector_eraser': return { label: t.tools.vectorEraser, hint: t.tools.vectorEraserHint };
    case 'shape': return { label: t.tools.shape, hint: t.tools.shapeHint };
    case 'text': return { label: t.tools.text, hint: t.tools.textHint };
    case 'comic_balloon': return { label: t.tools.comicBalloon, hint: t.tools.comicBalloonHint };
    case 'comic_panel': return { label: t.tools.comicPanel, hint: t.tools.comicPanelHint };
    case 'animation': return { label: t.tools.animation, hint: t.tools.animationHint };
    default: {
      const def = findTool(id);
      return { label: def?.label ?? id, hint: def?.hint ?? '' };
    }
  }
};

export const getLocalizedGroupLabel = (groupId: string, t: Translations): string => {
  switch (groupId) {
    case 'paint': return t.tools.groupPaint;
    case 'fill': return t.tools.groupFill;
    case 'select': return t.tools.groupSelect;
    case 'vector': return t.tools.groupVector;
    case 'create': return t.tools.groupCreate;
    default: return groupId;
  }
};

export const getLocalizedToolGroups = (t: Translations): ToolGroup[] => {
  return TOOL_GROUPS.map((g) => ({
    ...g,
    label: getLocalizedGroupLabel(g.id, t),
    tools: g.tools.map((tool) => {
      const loc = getLocalizedTool(tool.id, t);
      return {
        ...tool,
        label: loc.label,
        hint: loc.hint,
      };
    }),
  }));
};

/** Tools whose main control is a brush diameter */
export const SIZE_TOOLS: ToolType[] = ['brush', 'pencil', 'eraser', 'select_brush', 'select_eraser', 'blur', 'smudge', 'liquify', 'vector_pen', 'vector_bezier', 'vector_reshape', 'vector_width', 'vector_eraser'];

/** Size steps used by « » and the [ ] keys, roughly 15-25% apart like CSP's size presets */
export const SIZE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 400, 500];
export const MAX_BRUSH_SIZE = 500;

export const nextSizeStep = (size: number, direction: 1 | -1) => {
  if (direction > 0) return SIZE_STEPS.find((s) => s > size) ?? MAX_BRUSH_SIZE;
  return [...SIZE_STEPS].reverse().find((s) => s < size) ?? 1;
};
