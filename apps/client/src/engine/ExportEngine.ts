import { LayerModel, BlendMode } from '@atelier/shared';
import JSZip from 'jszip';
import { writePsd, Psd, Layer as PsdLayer } from 'ag-psd';

import { LayerCanvasItem, LayerTree, compositeLayers, maskCoverage } from './layerComposite';
import {
  buildVideoRecorderCandidates,
  createMediaRecorderForStream,
  getVideoBitrateForResolution,
  stopMediaStream,
  unwrapMediaRecorderError,
  type VideoExportResolution,
  type VideoRecorderCandidate,
} from './videoExport';
export type { LayerCanvasItem } from './layerComposite';

/** PSD layer masks are greyscale; an inverted mask is written as its negative (PSD has no invert flag) */
function greyMaskCanvas(mask: HTMLCanvasElement, inverted = false): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = mask.width;
  out.height = mask.height;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(mask.width, mask.height);
  const cov = maskCoverage(mask, inverted);
  for (let i = 0; i < cov.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = cov[i];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export type ExportFormat = 'lumina' | 'merged_png' | 'transparent_png' | 'jpeg' | 'psd' | 'ora' | 'layers_zip';

export class ExportEngine {
  /**
   * Helper to convert an HTMLCanvasElement to a Blob
   */
  public static canvasToBlob(canvas: HTMLCanvasElement, type: string = 'image/png'): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob conversion failed'));
      }, type);
    });
  }

  /**
   * Helper to trigger a browser file download for a given Blob
   */
  public static downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /** Merges the layers into one picture the way the editor draws them (see layerComposite) */
  public static compositeLayers(layerItems: LayerCanvasItem[], width: number, height: number, bgColor: string | null = '#FFFFFF'): HTMLCanvasElement {
    return compositeLayers(layerItems, width, height, bgColor);
  }

  /**
   * 1. Export Merged PNG (with or without background color)
   */
  public static async exportPng(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string | null,
    filename: string = 'canvas.png'
  ): Promise<Blob> {
    const mergedCanvas = this.compositeLayers(layerItems, width, height, bgColor);
    const blob = await this.canvasToBlob(mergedCanvas, 'image/png');
    return blob;
  }

  /**
   * 1.1 Export Merged JPEG (.jpg) with background color and high quality
   */
  public static async exportJpeg(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF',
    quality: number = 0.92
  ): Promise<Blob> {
    const mergedCanvas = this.compositeLayers(layerItems, width, height, bgColor || '#FFFFFF');
    return new Promise<Blob>((resolve, reject) => {
      mergedCanvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('JPEG conversion failed'));
        },
        'image/jpeg',
        quality
      );
    });
  }

  /**
   * Export Animated GIF (.gif) using gifenc
   */
  public static async exportGifAnimation(
    /** Renders frame i when the encoder is ready for it (frames are never all held at once) */
    nextFrame: (i: number) => Promise<{ canvas: HTMLCanvasElement; hold: number }>,
    frameCount: number,
    width: number,
    height: number,
    fps: number = 12
  ): Promise<Blob> {
    const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
    const gif = GIFEncoder();

    for (let i = 0; i < frameCount; i++) {
      const { canvas, hold } = await nextFrame(i);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const data = ctx.getImageData(0, 0, width, height).data;
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      // A held cel is one GIF frame with a longer delay
      gif.writeFrame(index, width, height, { palette, delay: Math.round((1000 / fps) * Math.max(1, hold)) });
    }

    gif.finish();
    const bytes = gif.bytes();
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' });
  }

  /**
   * Export Animated Video (.mp4 or .webm) using Canvas captureStream & MediaRecorder (streams 1 frame at a time)
   */
  public static async exportVideoAnimation(
    nextFrame: (i: number) => Promise<{ canvas: HTMLCanvasElement; hold: number }>,
    frameCount: number,
    width: number,
    height: number,
    fps: number = 12,
    format: 'mp4' | 'webm' = 'mp4',
    resolution: VideoExportResolution = '4k'
  ): Promise<Blob> {
    if (frameCount <= 0) throw new Error('No animation frames to export');
    const candidates = buildVideoRecorderCandidates(width, height, format, resolution);
    let lastError: Error | null = null;

    for (let i = 0; i < candidates.length; i++) {
      try {
        return await this.recordVideoAnimationAttempt(candidates[i], nextFrame, frameCount, fps, resolution);
      } catch (err) {
        lastError = unwrapMediaRecorderError(err);
        if (i === candidates.length - 1) throw lastError;
        console.warn(
          `[ExportEngine] Video candidate failed (${candidates[i].mimeType || 'default'} ${candidates[i].width}x${candidates[i].height}), trying fallback:`,
          lastError.message
        );
      }
    }

    throw lastError ?? new Error('Unable to initialize video recorder');
  }

  private static async recordVideoAnimationAttempt(
    candidate: VideoRecorderCandidate,
    nextFrame: (i: number) => Promise<{ canvas: HTMLCanvasElement; hold: number }>,
    frameCount: number,
    fps: number,
    resolution: VideoExportResolution = '4k'
  ): Promise<Blob> {
    const animCanvas = document.createElement('canvas');
    animCanvas.width = candidate.width;
    animCanvas.height = candidate.height;
    const ctx = animCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const stream = animCanvas.captureStream(fps);
    const recordedChunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = createMediaRecorderForStream(
        stream,
        candidate.mimeType,
        getVideoBitrateForResolution(resolution)
      );
    } catch (err) {
      animCanvas.width = 0;
      animCanvas.height = 0;
      stopMediaStream(stream);
      throw unwrapMediaRecorderError(err);
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    return new Promise<Blob>((resolve, reject) => {
      let aborted = false;
      let settled = false;
      const cleanupSurface = () => {
        stopMediaStream(stream);
        animCanvas.width = 0;
        animCanvas.height = 0;
      };
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        cleanupSurface();
        const blobType = recorder.mimeType || candidate.mimeType || 'video/webm';
        const blob = new Blob(recordedChunks, { type: blobType });
        if (blob.size === 0) {
          reject(new Error(`Video recorder produced empty output (${blobType})`));
          return;
        }
        resolve(blob);
      };
      recorder.onerror = (err) => {
        if (settled) return;
        aborted = true;
        settled = true;
        cleanupSurface();
        reject(unwrapMediaRecorderError(err));
      };

      const frameDelay = 1000 / Math.max(1, fps);
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

      void (async () => {
        try {
          // Paint first frame before starting recorder so frame 0 isn't blank
          const first = await nextFrame(0);
          if (aborted) return;
          ctx.clearRect(0, 0, candidate.width, candidate.height);
          ctx.drawImage(first.canvas, 0, 0, candidate.width, candidate.height);
          recorder.start(200);
          const startTime = performance.now();
          let logicalFrames = Math.max(1, first.hold);
          const firstDeadline = startTime + logicalFrames * frameDelay;
          if (firstDeadline > performance.now()) await sleep(firstDeadline - performance.now());

          for (let i = 1; i < frameCount && !aborted; i++) {
            const { canvas, hold } = await nextFrame(i);
            if (aborted) break;
            ctx.clearRect(0, 0, candidate.width, candidate.height);
            ctx.drawImage(canvas, 0, 0, candidate.width, candidate.height);
            logicalFrames += Math.max(1, hold);
            const targetTime = startTime + logicalFrames * frameDelay;
            const remaining = targetTime - performance.now();
            if (remaining > 0) await sleep(remaining);
          }

          await sleep(Math.min(250, frameDelay + 60));
          if (!aborted && recorder.state === 'recording') {
            try { recorder.requestData(); } catch {}
            recorder.stop();
          }
        } catch (err) {
          aborted = true;
          stopMediaStream(stream);
          try { if (recorder.state === 'recording') recorder.stop(); } catch {}
          if (!settled) {
            settled = true;
            reject(unwrapMediaRecorderError(err));
          }
        }
      })();
    });
  }

  /**
   * 2. Export Multi-Layer PNG Zip bundle (.zip): every layer as it finally looks (masks and
   * clipping applied), plus the merged picture and a manifest
   */
  public static async exportLayersZip(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF',
    canvasTitle: string = 'artwork'
  ): Promise<Blob> {
    const zip = new JSZip();
    const tree = new LayerTree(layerItems);
    const drawables = tree.drawables();

    for (let i = 0; i < drawables.length; i++) {
      const { item, clipBase } = drawables[i];
      const blob = await this.canvasToBlob(tree.flattened(item, clipBase), 'image/png');
      const safeName = item.layer.name.replace(/[\\/:*?"<>|]/g, '_');
      zip.file(`layer_${String(i).padStart(2, '0')}_${safeName}.png`, blob);
    }

    const compositeBlob = await this.canvasToBlob(this.compositeLayers(layerItems, width, height, bgColor), 'image/png');
    zip.file('composite.png', compositeBlob);

    const meta = {
      title: canvasTitle,
      width,
      height,
      bgColor,
      exportTime: new Date().toISOString(),
      layers: drawables.map(({ item }, idx) => ({
        index: idx,
        id: item.layer.id,
        name: item.layer.name,
        parent: item.layer.parentId ? tree.byId.get(item.layer.parentId)?.layer.name ?? null : null,
        opacity: tree.opacity(item),
        blendMode: item.layer.blendMode,
        isVisible: tree.visible(item),
        isLocked: item.layer.isLocked,
      })),
    };
    zip.file('layers_manifest.json', JSON.stringify(meta, null, 2));

    return await zip.generateAsync({ type: 'blob' });
  }

  /**
   * 3. Export OpenRaster (.ora) package (Krita, GIMP, MyPaint). Groups become nested stacks;
   * OpenRaster has no masks or clipping, so those are applied to the layer pixels.
   */
  public static async exportOpenRasterOra(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF'
  ): Promise<Blob> {
    const zip = new JSZip();

    // 1. mimetype MUST be first and stored uncompressed
    zip.file('mimetype', 'image/openraster', { compression: 'STORE' });

    // 2. composite and thumbnail images
    const compositeCanvas = this.compositeLayers(layerItems, width, height, bgColor);
    zip.file('mergedimage.png', await this.canvasToBlob(compositeCanvas, 'image/png'));

    const thumbCanvas = document.createElement('canvas');
    const thumbSize = 256;
    const aspect = width / height;
    thumbCanvas.width = aspect >= 1 ? thumbSize : Math.round(thumbSize * aspect);
    thumbCanvas.height = aspect >= 1 ? Math.round(thumbSize / aspect) : thumbSize;
    const thumbCtx = thumbCanvas.getContext('2d');
    if (thumbCtx) {
      thumbCtx.drawImage(compositeCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      zip.file('Thumbnails/thumbnail.png', await this.canvasToBlob(thumbCanvas, 'image/png'));
    }

    // 3. Layer images & stack.xml (top of the stack first)
    const tree = new LayerTree(layerItems);
    const clipBaseOf = new Map(tree.drawables().map((d) => [d.item.layer.id, d.clipBase]));
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let fileIndex = 0;
    const stackXml = async (parentId: string | null, indent: string): Promise<string> => {
      let xml = '';
      for (const item of [...tree.childrenOf(parentId)].reverse()) {
        const common = `name="${attr(item.layer.name)}" opacity="${item.layer.opacity}" visibility="${item.layer.isVisible ? 'visible' : 'hidden'}" composite-op="${this.mapToOraCompositeOp(item.layer.blendMode)}"`;
        if (tree.isGroup(item)) {
          xml += `${indent}<stack ${common} isolation="auto">\n${await stackXml(item.layer.id, indent + '  ')}${indent}</stack>\n`;
          continue;
        }
        // Group opacity / visibility live on the stacks; masks and clipping go into the pixels
        const pngPath = `data/layer_${fileIndex++}.png`;
        zip.file(pngPath, await this.canvasToBlob(tree.flattened(item, clipBaseOf.get(item.layer.id) ?? null), 'image/png'));
        xml += `${indent}<layer ${common} src="${pngPath}" x="0" y="0"/>\n`;
      }
      return xml;
    };

    zip.file('stack.xml', `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${width}" h="${height}">
  <stack>
${await stackXml(null, '    ')}  </stack>
</image>`);

    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'image/openraster',
    });
  }

  /**
   * 4. Export Adobe Photoshop (.psd): groups as folders, layer and group masks (greyscale,
   * disabled kept), clipping, names, opacity, blend modes and visibility
   */
  public static async exportPhotoshopPsd(
    layerItems: LayerCanvasItem[],
    width: number,
    height: number,
    bgColor: string = '#FFFFFF'
  ): Promise<Blob> {
    const compositeCanvas = this.compositeLayers(layerItems, width, height, bgColor);
    const tree = new LayerTree(layerItems);

    const toPsd = (item: LayerCanvasItem): PsdLayer => {
      const isGroup = tree.isGroup(item);
      const blend = this.mapToPsdBlendMode(item.layer.blendMode);
      const layer: PsdLayer = {
        name: item.layer.name,
        opacity: item.layer.opacity,
        // Groups here never isolate their blending, which is Photoshop's pass through
        blendMode: (isGroup && blend === 'normal' ? 'pass through' : blend) as any,
        hidden: !item.layer.isVisible,
        clipping: Boolean(item.layer.clipToBelow) && !isGroup,
        ...(item.mask ? {
          mask: { canvas: greyMaskCanvas(item.mask.canvas, item.mask.inverted), top: 0, left: 0, bottom: height, right: width, defaultColor: 0, disabled: !item.mask.enabled },
        } : {}),
      };
      if (isGroup) return { ...layer, opened: true, children: tree.childrenOf(item.layer.id).map(toPsd) };
      return { ...layer, canvas: item.canvas, top: 0, left: 0, bottom: height, right: width };
    };

    const psdDoc: Psd = {
      width,
      height,
      canvas: compositeCanvas,
      children: tree.childrenOf(null).map(toPsd),
    };

    const psdBuffer = writePsd(psdDoc);
    return new Blob([psdBuffer], { type: 'image/vnd.adobe.photoshop' });
  }

  private static mapToOraCompositeOp(mode: BlendMode): string {
    switch (mode) {
      case 'multiply':
      case 'linear_burn':
        return 'svg:multiply';
      case 'screen':
      case 'divide':
        return 'svg:screen';
      case 'overlay':
        return 'svg:overlay';
      case 'darken':
        return 'svg:darken';
      case 'lighten':
        return 'svg:lighten';
      case 'color_dodge':
        return 'svg:color-dodge';
      case 'color_burn':
        return 'svg:color-burn';
      case 'hard_light':
      case 'linear_light':
        return 'svg:hard-light';
      case 'soft_light':
        return 'svg:soft-light';
      case 'difference':
      case 'subtract':
        return 'svg:difference';
      case 'add':
      case 'glow':
        return 'svg:plus';
      default:
        return 'svg:src-over';
    }
  }

  private static mapToPsdBlendMode(mode: BlendMode): string {
    switch (mode) {
      case 'multiply':
        return 'multiply';
      case 'linear_burn':
        return 'linear burn';
      case 'screen':
        return 'screen';
      case 'overlay':
        return 'overlay';
      case 'darken':
        return 'darken';
      case 'darker_color':
        return 'darker color';
      case 'lighten':
        return 'lighten';
      case 'lighter_color':
        return 'lighter color';
      case 'color_dodge':
        return 'color dodge';
      case 'color_burn':
        return 'color burn';
      case 'hard_light':
        return 'hard light';
      case 'soft_light':
        return 'soft light';
      case 'vivid_light':
        return 'vivid light';
      case 'linear_light':
        return 'linear light';
      case 'pin_light':
        return 'pin light';
      case 'hard_mix':
        return 'hard mix';
      case 'difference':
        return 'difference';
      case 'exclusion':
        return 'exclusion';
      case 'subtract':
        return 'subtract';
      case 'divide':
        return 'divide';
      case 'add':
      case 'glow':
        return 'linear dodge';
      case 'hue':
        return 'hue';
      case 'saturation':
        return 'saturation';
      case 'color':
        return 'color';
      case 'luminosity':
        return 'luminosity';
      default:
        return 'normal';
    }
  }
}
