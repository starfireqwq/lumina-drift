import { Renderer, RenderTexture } from 'pixi.js';
import {
  applyChromaticAberration,
  applyColorCurves,
  applyGaussianBlur,
  applyGradientMap,
  applyHalftoneDot,
  applyHsvAdjust,
  applyNoiseGrain,
  applyTwirlDistortion,
  ColorCurvesOptions,
  GradientPresetName,
  GradientStop,
  TileData,
} from '@atelier/shared';
import { TileEngine } from './TileEngine';

export interface FilterRunResult {
  dirtyTiles: TileData[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  filterType: string;
}

export class WebGLFilterEngine {
  private renderer: Renderer;
  private tileEngine: TileEngine;
  private canvasWidth: number;
  private canvasHeight: number;

  constructor(
    renderer: Renderer,
    tileEngine: TileEngine,
    canvasWidth: number = 2048,
    canvasHeight: number = 2048
  ) {
    this.renderer = renderer;
    this.tileEngine = tileEngine;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
  }

  public setDimensions(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  /**
   * Helper to extract full pixel buffer from target RenderTexture
   */
  private extractPixels(targetRT: RenderTexture): Uint8Array {
    return this.tileEngine.readRegion(targetRT, 0, 0, this.canvasWidth, this.canvasHeight);
  }

  /**
   * Applies Gaussian Blur to target layer RenderTexture
   * Synchronizes dirty tiles through TileEngine
   */
  public applyGaussianBlur(
    targetRT: RenderTexture,
    radius: number = 8,
    selectionMask?: Uint8Array | null,
    targetBounds?: { minX: number; minY: number; maxX: number; maxY: number }
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyGaussianBlur(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      radius
    );

    // Determine dirty region bounds
    const bounds = targetBounds || {
      minX: 0,
      minY: 0,
      maxX: this.canvasWidth,
      maxY: this.canvasHeight,
    };

    // Calculate dirty tiles touched by the filter
    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    // Extract updated tiles with LZ4 compression
    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');

    // Apply back into target RenderTexture
    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'GAUSSIAN_BLUR',
    };
  }

  /**
   * Applies Twirl / Vortex Distortion
   */
  public applyTwirl(
    targetRT: RenderTexture,
    centerX: number,
    centerY: number,
    radius: number,
    angleRad: number,
    selectionMask?: Uint8Array | null
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyTwirlDistortion(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      centerX,
      centerY,
      radius,
      angleRad
    );

    const bounds = {
      minX: Math.max(0, Math.floor(centerX - radius)),
      minY: Math.max(0, Math.floor(centerY - radius)),
      maxX: Math.min(this.canvasWidth, Math.ceil(centerX + radius)),
      maxY: Math.min(this.canvasHeight, Math.ceil(centerY + radius)),
    };

    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');

    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'TWIRL',
    };
  }

  /**
   * Applies Manga Halftone Screen Tone Dot Filter
   */
  public applyHalftone(
    targetRT: RenderTexture,
    density: number = 40,
    angleRad: number = Math.PI / 4,
    dotScale: number = 1.0,
    selectionMask?: Uint8Array | null
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyHalftoneDot(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      density,
      angleRad,
      dotScale
    );

    const bounds = { minX: 0, minY: 0, maxX: this.canvasWidth, maxY: this.canvasHeight };
    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');

    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'HALFTONE_DOT',
    };
  }

  /**
   * Applies Chromatic Aberration / RGB Split
   */
  public applyChromaticAberration(
    targetRT: RenderTexture,
    offsetX: number = 4,
    offsetY: number = 0,
    selectionMask?: Uint8Array | null
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyChromaticAberration(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      offsetX,
      offsetY
    );

    const bounds = { minX: 0, minY: 0, maxX: this.canvasWidth, maxY: this.canvasHeight };
    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');

    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'CHROMATIC_ABERRATION',
    };
  }

  /**
   * Applies Digital Noise & Paper Grain
   */
  public applyNoiseGrain(
    targetRT: RenderTexture,
    intensity: number = 0.25,
    grainSize: number = 1.0,
    selectionMask?: Uint8Array | null
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyNoiseGrain(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      intensity,
      grainSize
    );

    const bounds = { minX: 0, minY: 0, maxX: this.canvasWidth, maxY: this.canvasHeight };
    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');

    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'NOISE_GRAIN',
    };
  }

  /**
   * Applies HSV Adjustment & Color Invert
   */
  public applyHsvAdjust(
    targetRT: RenderTexture,
    hueShift: number = 0,
    saturation: number = 1.0,
    brightness: number = 0,
    invert: boolean = false,
    selectionMask?: Uint8Array | null
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyHsvAdjust(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      hueShift,
      saturation,
      brightness,
      invert
    );

    const bounds = { minX: 0, minY: 0, maxX: this.canvasWidth, maxY: this.canvasHeight };
    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');
    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'HSV_ADJUST',
    };
  }

  /**
   * Applies Color Curves (Bézier Tone Curves & Individual RGB Channels)
   */
  public applyColorCurves(
    targetRT: RenderTexture,
    options: ColorCurvesOptions,
    selectionMask?: Uint8Array | null
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyColorCurves(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      options
    );

    const bounds = { minX: 0, minY: 0, maxX: this.canvasWidth, maxY: this.canvasHeight };
    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');
    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'COLOR_CURVES',
    };
  }

  /**
   * Applies Gradient Map (Maps perceptual luminance to Sunset, Cyberpunk, Monochrome Ink ramps)
   */
  public applyGradientMap(
    targetRT: RenderTexture,
    stopsOrPreset: GradientStop[] | GradientPresetName = 'sunset',
    opacity: number = 1.0,
    selectionMask?: Uint8Array | null
  ): FilterRunResult {
    const rawPixels = this.extractPixels(targetRT);

    const filtered = applyGradientMap(
      {
        pixels: rawPixels,
        width: this.canvasWidth,
        height: this.canvasHeight,
        selectionMask,
      },
      stopsOrPreset,
      opacity
    );

    const bounds = { minX: 0, minY: 0, maxX: this.canvasWidth, maxY: this.canvasHeight };
    const coords = this.tileEngine.getDirtyTilesForBounds(
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY
    );

    const dirtyTiles = this.tileEngine.extractMultipleTilesFromBuffer(filtered, coords, 'lz4');
    this.tileEngine.applyTileBatch(targetRT, dirtyTiles);

    return {
      dirtyTiles,
      bounds,
      filterType: 'GRADIENT_MAP',
    };
  }
}
