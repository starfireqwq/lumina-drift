/**
 * AtelierSync Brush Package (.asbrush / .asbrushpack) Engine
 * Handles brush preset packaging, import/export, and auto-conversion from ABR/SUT/Images.
 */

import { AbrParser, type ParsedBrushTip } from './abr-parser';
import { SutParser } from './sut-parser';
import { MIN_BRUSH_SPACING } from './brush-spacing';
import type { PressureCurveConfig } from './pressure-curve';
import type {
  BrushDynamicsConfig,
  BrushMixMode,
  BrushTextureBlendMode,
  DualBrushBlendMode,
} from './brush-dynamics';

export interface AtelierBrushPreset {
  id: string;
  name: string;
  category?: string;
  author?: string;
  version: string;
  description?: string;
  properties: {
    size: number;
    minSize: number;
    color: string;
    opacity: number;
    flow: number;
    hardness: number;
    spacing: number;
    isEraser: boolean;
    stabilizerLevel: number;
    scatter: number;
    colorMixing?: number; // 0.0 to 1.0 (混色度)
    paintAmount?: number; // 0.0 to 1.0 (水分 / 顏料量)
    pressureCurve?: string | PressureCurveConfig;
    colorStretch?: number;
    mixMode?: BrushMixMode;
    brushType?: string;
    snapToRuler?: boolean;
    textureDensity?: number;
    textureScale?: number;
    textureInvert?: boolean;
    textureBlendMode?: BrushTextureBlendMode;
    customTextureUrl?: string | null;
    dualBrush?: boolean;
    dualSize?: number;
    dualScatter?: number;
    dualTipUrl?: string | null;
    dualBlendMode?: DualBrushBlendMode;
    hueJitter?: number;
    satJitter?: number;
    valJitter?: number;
    fgBgMix?: number;
    angleMode?: 'direction' | 'pen' | 'fixed';
    tipAngle?: number;
    roundness?: number;
    tiltSize?: number;
    wetEdges?: boolean;
    dynamics?: BrushDynamicsConfig;
  };
  tipDataUrl?: string | null;
  textureDataUrl?: string | null;
  dualTipDataUrl?: string | null;
  tags?: string[];
  createdAt: number;
}

export interface AtelierBrushPack {
  name: string;
  author: string;
  description?: string;
  brushes: AtelierBrushPreset[];
  version: string;
  createdAt: number;
}

export const DEFAULT_COMMUNITY_PRESETS: AtelierBrushPreset[] = [
  {
    id: 'preset_thick_oil_impasto',
    name: '經典油畫厚塗筆 (Thick Impasto)',
    category: '厚塗插畫',
    author: 'Lumina Drift Studio',
    version: '1.0',
    description: '濃郁厚實覆蓋感，支援感壓濃淡過渡與手繪厚塗混色堆疊',
    properties: {
      size: 40,
      minSize: 22,
      color: '#3B82F6',
      opacity: 1.0,
      flow: 0.85,
      hardness: 0.54,
      spacing: MIN_BRUSH_SPACING,
      isEraser: false,
      stabilizerLevel: 3,
      scatter: 0,
      brushType: 'brush',
      colorMixing: 0.86,
      paintAmount: 0.25,
      colorStretch: 0.78,
      pressureCurve: 'linear',
    },
    tipDataUrl: null,
    tags: ['ThickPaint', 'Impasto', 'Oil'],
    createdAt: Date.now(),
  },
  {
    id: 'preset_csp_gpen',
    name: '俐落勾線筆 (Crisp Inking Pen)',
    category: '線稿勾勒',
    author: 'Lumina Drift Studio',
    version: '1.0',
    description: '日系動漫線稿首選，高靈敏壓感與俐落收尖',
    properties: {
      size: 14,
      minSize: 0,
      color: '#1e293b',
      opacity: 1.0,
      flow: 1.0,
      hardness: 0.95,
      spacing: MIN_BRUSH_SPACING,
      isEraser: false,
      stabilizerLevel: 4,
      scatter: 0,
      brushType: 'pen',
      colorMixing: 0.0,
      paintAmount: 1.0,
      pressureCurve: 's-curve',
    },
    tipDataUrl: null,
    tags: ['Lineart', 'Inking', 'Manga'],
    createdAt: Date.now(),
  },
  {
    id: 'preset_csp_watercolor',
    name: '濕染水彩筆 (Wet Watercolor)',
    category: '擬真手繪',
    author: 'Lumina Drift Studio',
    version: '1.0',
    description: '基於感壓透明度與水分浸潤混色，重現水彩柔邊暈染與堆疊感',
    properties: {
      size: 48,
      minSize: 26,
      color: '#3b82f6',
      opacity: 0.9,
      flow: 0.65,
      hardness: 0.35,
      spacing: MIN_BRUSH_SPACING,
      isEraser: false,
      stabilizerLevel: 2,
      scatter: 0,
      brushType: 'brush',
      colorMixing: 0.5,
      paintAmount: 0.75,
      pressureCurve: 'linear',
    },
    tipDataUrl: null,
    tags: ['Watercolor', 'Blending', 'Organic'],
    createdAt: Date.now(),
  },
  {
    id: 'preset_ps_thick_oil',
    name: '概念厚塗油畫 (Oil Impasto)',
    category: '厚塗插畫',
    author: 'Lumina Drift Studio',
    version: '1.0',
    description: '飽和度高、筆觸厚實，支援感壓濃淡與自然底色融合',
    properties: {
      size: 56,
      minSize: 30,
      color: '#f97316',
      opacity: 1.0,
      flow: 0.9,
      hardness: 0.58,
      spacing: MIN_BRUSH_SPACING,
      isEraser: false,
      stabilizerLevel: 2,
      scatter: 0,
      brushType: 'brush',
      colorMixing: 0.68,
      paintAmount: 0.64,
      pressureCurve: 'linear',
    },
    tipDataUrl: null,
    tags: ['ConceptArt', 'Oil', 'ThickPaint'],
    createdAt: Date.now(),
  },
  {
    id: 'preset_soft_airbrush',
    name: '柔和羽化噴槍 (Soft Airbrush)',
    category: '上色光影',
    author: 'Lumina Drift Studio',
    version: '1.0',
    description: '極致柔和過渡，適合角色肌膚紅暈與環境光渲染，具備細膩壓感與零顆粒感',
    properties: {
      size: 120,
      minSize: 72,
      color: '#ec4899',
      opacity: 0.85,
      flow: 0.35,
      hardness: 0.0,
      spacing: MIN_BRUSH_SPACING,
      isEraser: false,
      stabilizerLevel: 1,
      scatter: 0,
      brushType: 'airbrush',
      colorMixing: 0.0,
      paintAmount: 1.0,
      pressureCurve: 'linear',
    },
    tipDataUrl: null,
    tags: ['Airbrush', 'Shading', 'Soft'],
    createdAt: Date.now(),
  },
  {
    id: 'preset_rough_pastel',
    name: '粗質顆粒粉彩 (Rough Pastel)',
    category: '質感紋理',
    author: 'Lumina Drift Studio',
    version: '1.0',
    description: '具備紙質雜訊紋理與自然散佈顆粒感',
    properties: {
      size: 36,
      minSize: 16,
      color: '#10b981',
      opacity: 0.9,
      flow: 0.75,
      hardness: 0.6,
      spacing: MIN_BRUSH_SPACING,
      isEraser: false,
      stabilizerLevel: 3,
      scatter: 0.06,
      brushType: 'brush',
      colorMixing: 0.25,
      paintAmount: 0.8,
      pressureCurve: 'linear',
    },
    tipDataUrl: null,
    tags: ['Pastel', 'Texture', 'Grain'],
    createdAt: Date.now(),
  },
];

export class BrushPackageManager {
  /**
   * Export a single preset to JSON string (.asbrush)
   */
  public static exportPresetToJson(preset: AtelierBrushPreset): string {
    return JSON.stringify(preset, null, 2);
  }

  /**
   * Export a pack of presets to JSON string (.asbrushpack)
   */
  public static exportPackToJson(pack: AtelierBrushPack): string {
    return JSON.stringify(pack, null, 2);
  }

  /**
   * Unified parser for multiple brush file formats:
   * .abr (Photoshop), .sut (Clip Studio Paint), .asbrush, .asbrushpack, or image files
   */
  public static async parseBrushFile(
    buffer: ArrayBuffer | ArrayBufferView,
    fileName: string
  ): Promise<AtelierBrushPreset[]> {
    const lowerName = fileName.toLowerCase();
    const byteView =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(
            (buffer as any).buffer,
            (buffer as any).byteOffset,
            (buffer as any).byteLength
          );

    // 1. .asbrush (Single preset)
    if (lowerName.endsWith('.asbrush') || lowerName.endsWith('.json')) {
      try {
        const text = new TextDecoder('utf-8').decode(byteView).trim();
        const parsed = JSON.parse(text);
        if (parsed.properties && parsed.name) {
          return [parsed as AtelierBrushPreset];
        }
        if (parsed.brushes && Array.isArray(parsed.brushes)) {
          return parsed.brushes as AtelierBrushPreset[];
        }
      } catch (err) {
        console.warn('JSON brush parsing failed:', err);
      }
    }

    // 2. .asbrushpack (Collection)
    if (lowerName.endsWith('.asbrushpack')) {
      try {
        const text = new TextDecoder('utf-8').decode(byteView).trim();
        const parsed = JSON.parse(text);
        if (parsed.brushes && Array.isArray(parsed.brushes)) {
          return parsed.brushes;
        }
      } catch (err) {
        console.warn('Pack parsing failed:', err);
      }
    }

    const mapParsedTipToProperties = (
      tip: ParsedBrushTip,
      defaults: {
        size: number;
        minSize: number;
        color: string;
        opacity: number;
        flow: number;
        hardness: number;
        stabilizerLevel: number;
        colorMixing: number;
        paintAmount: number;
      }
    ): AtelierBrushPreset['properties'] => {
      const size = Math.max(1, Math.min(500, Math.round(tip.size ?? defaults.size)));
      const minSize = tip.minSize !== undefined
        ? Math.max(0, Math.min(size, tip.minSize))
        : tip.dynamics?.size?.min !== undefined
          ? Math.round(size * tip.dynamics.size.min * 10) / 10
          : defaults.minSize;
      return {
        size,
        minSize,
        color: defaults.color,
        opacity: tip.opacity ?? defaults.opacity,
        flow: tip.flow ?? defaults.flow,
        hardness: tip.hardness ?? defaults.hardness,
        spacing: Math.max(MIN_BRUSH_SPACING, Math.min(1.5, tip.spacing ?? MIN_BRUSH_SPACING)),
        isEraser: false,
        stabilizerLevel: defaults.stabilizerLevel,
        scatter: tip.scatter ?? 0,
        colorMixing: tip.colorMixing ?? defaults.colorMixing,
        paintAmount: tip.paintAmount ?? defaults.paintAmount,
        colorStretch: tip.colorStretch ?? 0,
        mixMode: tip.mixMode,
        pressureCurve: 's-curve',
        textureDensity: tip.textureDensity ?? 0,
        textureScale: tip.textureScale ?? 1,
        textureInvert: tip.textureInvert,
        textureBlendMode: tip.textureBlendMode,
        customTextureUrl: tip.textureDataUrl ?? null,
        dualBrush: tip.dualBrush ?? false,
        dualSize: tip.dualSize ?? 0.4,
        dualScatter: tip.dualScatter ?? 0.6,
        dualTipUrl: tip.dualTipDataUrl ?? null,
        dualBlendMode: tip.dualBlendMode,
        hueJitter: tip.hueJitter ?? 0,
        satJitter: tip.satJitter ?? 0,
        valJitter: tip.valJitter ?? 0,
        fgBgMix: tip.fgBgMix ?? 0,
        angleMode: tip.angleMode ?? 'direction',
        tipAngle: tip.angle ?? 0,
        roundness: tip.roundness ?? 1,
        tiltSize: tip.tiltSize ?? 0,
        wetEdges: tip.wetEdges ?? false,
        dynamics: tip.dynamics,
      };
    };

    // 3. .abr (Photoshop ABR)
    if (lowerName.endsWith('.abr')) {
      const parser = new AbrParser(byteView);
      const brushes: AtelierBrushPreset[] = [];
      for (const tip of parser.tips()) {
        brushes.push({
          id: `imported_abr_${Date.now()}_${brushes.length}`,
          name: tip.name,
          category: 'ABR 筆刷匯入',
          author: 'ABR 筆刷',
          version: '2.0',
          description: `從 ${fileName} 還原的筆刷設定與筆尖`,
          properties: mapParsedTipToProperties(tip, {
            size: Math.min(Math.max(tip.width || 32, 24), 128),
            minSize: 4,
            color: '#3b82f6',
            opacity: 1.0,
            flow: 0.9,
            hardness: 0.8,
            stabilizerLevel: 3,
            colorMixing: 0,
            paintAmount: 0.7,
          }),
          tipDataUrl: tip.dataUrl,
          textureDataUrl: tip.textureDataUrl ?? null,
          dualTipDataUrl: tip.dualTipDataUrl ?? null,
          tags: ['ABR', 'Imported'],
          createdAt: Date.now(),
        });
        if (typeof document !== 'undefined' && brushes.length % 8 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      if (brushes.length) return brushes;
    }

    // 4. .sut
    if (lowerName.endsWith('.sut')) {
      const parser = new SutParser(byteView.buffer.slice(byteView.byteOffset, byteView.byteOffset + byteView.byteLength) as ArrayBuffer);
      const tips = parser.parse();
      if (tips.length > 0) {
        return tips.map((tip, index) => ({
          id: `imported_sut_${Date.now()}_${index}`,
          name: tip.name,
          category: 'SUT 筆刷匯入',
          author: 'SUT 筆刷',
          version: '2.0',
          description: `從 ${fileName} 還原之筆刷設定與貼圖`,
          properties: mapParsedTipToProperties(tip, {
            size: 32,
            minSize: 2,
            color: '#10b981',
            opacity: 0.95,
            flow: 0.85,
            hardness: 0.85,
            stabilizerLevel: 4,
            colorMixing: 0,
            paintAmount: 0.75,
          }),
          tipDataUrl: tip.dataUrl,
          textureDataUrl: tip.textureDataUrl ?? null,
          dualTipDataUrl: tip.dualTipDataUrl ?? null,
          tags: ['SUT', 'Imported'],
          createdAt: Date.now(),
        }));
      }
    }

    // 5. Image files (PNG, JPG, WEBP as custom tip texture)
    if (
      lowerName.endsWith('.png') ||
      lowerName.endsWith('.jpg') ||
      lowerName.endsWith('.jpeg') ||
      lowerName.endsWith('.webp')
    ) {
      const mime = lowerName.endsWith('.png')
        ? 'image/png'
        : lowerName.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg';
      const bytes = byteView;
      let base64 = '';
      if (typeof (globalThis as any).Buffer !== 'undefined') {
        base64 = (globalThis as any).Buffer.from(bytes).toString('base64');
      } else {
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        base64 = (globalThis as any).btoa(binary);
      }
      const dataUrl = `data:${mime};base64,${base64}`;

      const cleanName = fileName.replace(/\.[^/.]+$/, '');
      return [
        {
          id: `imported_img_${Date.now()}`,
          name: `自訂筆尖貼圖 (${cleanName})`,
          category: '自訂圖樣',
          author: 'User',
          version: '1.0',
          description: `由圖檔 ${fileName} 匯入`,
          properties: {
            size: 48,
            minSize: 6,
            color: '#8b5cf6',
            opacity: 1.0,
            flow: 1.0,
            hardness: 0.8,
            spacing: MIN_BRUSH_SPACING,
            isEraser: false,
            stabilizerLevel: 3,
            scatter: 0,
            colorMixing: 0.3,
            paintAmount: 0.7,
            pressureCurve: 's-curve',
          },
          tipDataUrl: dataUrl,
          tags: ['CustomImage'],
          createdAt: Date.now(),
        },
      ];
    }

    throw new Error(`無法識別的筆刷檔案格式: ${fileName}。支援格式: .abr, .sut, .asbrush, .png, .jpg`);
  }
}
