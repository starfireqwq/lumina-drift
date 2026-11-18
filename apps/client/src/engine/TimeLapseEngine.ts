import { LayerModel, decompressTileBuffer } from '@atelier/shared';
import { animationDisplay } from './AnimationEngine';
import { compositeLayers, type LayerCanvasItem } from './layerComposite';
import { ApiService } from '../services/api';

export type ReplayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'completed' | 'recording';

export interface ReplayProgress {
  currentOpIndex: number;
  totalOps: number;
  currentSeq: number;
  progressPercent: number;
  status: ReplayStatus;
}

export interface ReplayEngineOptions {
  onProgress?: (progress: ReplayProgress) => void;
  onStatusChange?: (status: ReplayStatus) => void;
}

export class TimeLapseEngine {
  private canvasId: string = '';
  private width: number = 2048;
  private height: number = 2048;
  private bgColor: string = '#FFFFFF';
  private layers: LayerModel[] = [];
  private ops: any[] = [];

  // Rendering canvases
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private layerCanvases: Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> = new Map();

  // Playback state
  private status: ReplayStatus = 'idle';
  private currentOpIndex: number = 0;
  private speed: number = 4; // Default 4x
  private animationFrameId: number | null = null;
  private lastStepTimestamp: number = 0;

  // Video recording
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  private options: ReplayEngineOptions;

  constructor(previewCanvas: HTMLCanvasElement, options: ReplayEngineOptions = {}) {
    this.previewCanvas = previewCanvas;
    const ctx = previewCanvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D rendering context for preview canvas');
    this.previewCtx = ctx;
    this.options = options;
  }

  public getStatus(): ReplayStatus {
    return this.status;
  }

  public getOpsCount(): number {
    return this.ops.length;
  }

  public getCurrentOpIndex(): number {
    return this.currentOpIndex;
  }

  public setSpeed(speed: number) {
    this.speed = Math.max(1, speed);
  }

  public getSpeed(): number {
    return this.speed;
  }

  /**
   * Initializes and loads all operations for a canvas from SQLite canvas_ops
   */
  public async loadCanvasHistory(
    canvasId: string,
    width: number,
    height: number,
    bgColor: string,
    layers: LayerModel[]
  ): Promise<number> {
    this.stop();
    this.canvasId = canvasId;
    this.width = width;
    this.height = height;
    this.bgColor = bgColor || '#FFFFFF';
    this.layers = [...layers].sort((a, b) => a.sortOrder - b.sortOrder);

    this.setStatus('loading');

    // Resize preview canvas (keep aspect ratio in display)
    this.previewCanvas.width = width;
    this.previewCanvas.height = height;

    // Initialize layer canvases
    this.layerCanvases.clear();
    for (const layer of this.layers) {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        this.layerCanvases.set(layer.id, { canvas: c, ctx });
      }
    }

    // Clear and draw initial background
    this.clearAll();

    // Fetch all operations from sequence 0 onwards
    try {
      const res = await ApiService.getOpsSince(canvasId, 0);
      this.ops = res?.ops || [];
    } catch (err) {
      console.error('[TimeLapseEngine] Failed to fetch operations history:', err);
      this.ops = [];
    }

    this.currentOpIndex = 0;
    this.setStatus(this.ops.length > 0 ? 'paused' : 'idle');
    this.emitProgress();

    return this.ops.length;
  }

  /**
   * Clears all layer canvases and draws base canvas
   */
  private clearAll() {
    for (const { ctx } of this.layerCanvases.values()) {
      ctx.clearRect(0, 0, this.width, this.height);
    }
    this.compositePreview();
  }

  /**
   * Composites all visible layer canvases onto the main preview canvas
   */
  private compositePreview() {
    // As the editor draws it: masks hide (they are not pictures), groups and clipping apply,
    // and each animation folder shows its first frame instead of every cel stacked up
    const shown = animationDisplay(this.layers, null);
    const items: LayerCanvasItem[] = [];
    for (const layer of shown) {
      if (layer.layerType === 'mask') continue;
      const maskLayer = this.layers.find((m) => m.layerType === 'mask' && m.parentId === layer.id);
      const maskCanvas = maskLayer && this.layerCanvases.get(maskLayer.id)?.canvas;
      items.push({
        layer,
        canvas: this.layerCanvases.get(layer.id)?.canvas ?? this.emptyCanvas,
        mask: maskLayer && maskCanvas ? { canvas: maskCanvas, enabled: maskLayer.isVisible, inverted: Boolean(maskLayer.meta?.maskInverted) } : undefined,
      });
    }
    compositeLayers(items, this.width, this.height, this.bgColor, this.previewCanvas);
  }
  private emptyCanvas = document.createElement('canvas');

  /**
   * Starts playback from current position
   */
  public play() {
    if (this.ops.length === 0) return;
    if (this.currentOpIndex >= this.ops.length) {
      this.seek(0);
    }
    this.setStatus('playing');
    this.lastStepTimestamp = performance.now();
    this.scheduleNextStep();
  }

  /**
   * Pauses playback
   */
  public pause() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.setStatus('paused');
    this.emitProgress();
  }

  /**
   * Stops and resets playback to op 0
   */
  public stop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.clearAll();
    this.currentOpIndex = 0;
    this.setStatus('paused');
    this.emitProgress();
  }

  /**
   * Seeks to a specific operation index
   */
  public seek(targetIndex: number) {
    const wasPlaying = this.status === 'playing';
    this.pause();

    const clamped = Math.max(0, Math.min(targetIndex, this.ops.length));
    this.clearAll();

    // Fast-replay all operations from 0 to clamped
    for (let i = 0; i < clamped; i++) {
      this.executeOp(this.ops[i]);
    }

    this.currentOpIndex = clamped;
    this.compositePreview();

    if (wasPlaying && clamped < this.ops.length) {
      this.play();
    } else {
      this.setStatus(clamped >= this.ops.length ? 'completed' : 'paused');
      this.emitProgress();
    }
  }

  /**
   * Animation frame loop with speed multiplier
   */
  private scheduleNextStep() {
    if (this.status !== 'playing' && this.status !== 'recording') return;

    this.animationFrameId = requestAnimationFrame((timestamp) => {
      if (this.status !== 'playing' && this.status !== 'recording') return;

      const elapsed = timestamp - this.lastStepTimestamp;
      // Steps per frame depends on speed
      const baseDelay = 30 / this.speed;

      if (elapsed >= baseDelay || this.speed >= 16) {
        const opsToProcess = this.speed >= 16 ? Math.min(Math.floor(this.speed / 4), 16) : 1;

        for (let i = 0; i < opsToProcess; i++) {
          if (this.currentOpIndex < this.ops.length) {
            const op = this.ops[this.currentOpIndex];
            this.executeOp(op);
            this.currentOpIndex++;
          } else {
            break;
          }
        }

        this.compositePreview();
        this.emitProgress();
        this.lastStepTimestamp = timestamp;

        if (this.currentOpIndex >= this.ops.length) {
          this.setStatus('completed');
          this.emitProgress();
          return;
        }
      }

      this.scheduleNextStep();
    });
  }

  /**
   * Executes a single operation on the designated layer canvas
   */
  private executeOp(op: any) {
    if (!op || !op.layerId) return;

    let targetLayer = this.layerCanvases.get(op.layerId);
    if (!targetLayer) {
      // Dynamic layer creation fallback
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        targetLayer = { canvas: c, ctx };
        this.layerCanvases.set(op.layerId, targetLayer);
      } else {
        return;
      }
    }

    const { ctx } = targetLayer;
    const payload = op.payload;
    const opType = (op.opType || '').toUpperCase();

    // 1. STROKE / ERASE
    if (opType === 'STROKE' || opType === 'ERASE') {
      const samplePoints = payload?.samplePoints || [];
      const brushSize = payload?.size || 16;
      const color = payload?.color || '#000000';
      const isEraser = opType === 'ERASE' || Boolean(payload?.isEraser);
      const opacity = payload?.opacity !== undefined ? payload.opacity : 1.0;

      ctx.save();
      if (isEraser) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.fillStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.globalAlpha = opacity;
      }

      if (samplePoints.length === 1) {
        const pt = samplePoints[0];
        const rad = Math.max(1, (brushSize * (pt.pressure || 0.5)) / 2);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
        ctx.fill();
      } else if (samplePoints.length > 1) {
        for (let i = 0; i < samplePoints.length - 1; i++) {
          const p1 = samplePoints[i];
          const p2 = samplePoints[i + 1];
          const avgPressure = ((p1.pressure || 0.5) + (p2.pressure || 0.5)) / 2;
          ctx.lineWidth = Math.max(1, brushSize * avgPressure);

          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();

          // Smooth dab caps
          const r = ctx.lineWidth / 2;
          ctx.beginPath();
          ctx.arc(p2.x, p2.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    // 2. TILE_PATCH
    else if (opType === 'TILE_PATCH' && payload?.tiles) {
      const tiles = payload.tiles;
      const tileSize = 256;
      for (const t of tiles) {
        if (!t.data) continue;
        try {
          const rawBytes = decompressTileBuffer(t.data, t.compression || 'lz4', tileSize * tileSize * 4);
          const imgData = new ImageData(new Uint8ClampedArray(rawBytes), tileSize, tileSize);
          ctx.putImageData(imgData, t.col * tileSize, t.row * tileSize);
        } catch {
          // Skip corrupt tile
        }
      }
    }
    // 3. LAYER_OP (e.g., clear or opacity)
    else if (opType === 'LAYER_CLEAR') {
      ctx.clearRect(0, 0, this.width, this.height);
    }
  }

  /**
   * Records the entire replay into a WebM or MP4 short video file
   */
  public async exportTimeLapseVideo(
    format: 'webm' | 'mp4' = 'webm',
    onProgress?: (percent: number) => void
  ): Promise<Blob> {
    if (this.ops.length === 0) {
      throw new Error('畫布無操作紀錄可供匯出影片');
    }

    this.pause();
    this.seek(0);
    this.setStatus('recording');

    // Setup MediaStream from preview canvas
    const stream = this.previewCanvas.captureStream(30);

    // Determine supported mimeType
    let mimeType = 'video/webm;codecs=vp9';
    if (format === 'mp4' && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')) {
      mimeType = 'video/mp4;codecs=avc1';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
      mimeType = 'video/webm;codecs=vp9';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
      mimeType = 'video/webm;codecs=vp8';
    } else if (MediaRecorder.isTypeSupported('video/webm')) {
      mimeType = 'video/webm';
    } else {
      mimeType = '';
    }

    this.recordedChunks = [];
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4000000 })
      : new MediaRecorder(stream);

    this.mediaRecorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    return new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        const finalBlob = new Blob(this.recordedChunks, {
          type: mimeType || 'video/webm',
        });
        this.setStatus('completed');
        resolve(finalBlob);
      };

      recorder.onerror = (e) => {
        this.setStatus('paused');
        reject(e);
      };

      recorder.start(100);

      // Play through all operations at accelerated speed for video generation
      const originalSpeed = this.speed;
      this.speed = 16; // Fast render speed for video recording

      const checkCompletion = () => {
        if (this.currentOpIndex < this.ops.length) {
          const batch = 8;
          for (let b = 0; b < batch && this.currentOpIndex < this.ops.length; b++) {
            this.executeOp(this.ops[this.currentOpIndex]);
            this.currentOpIndex++;
          }
          this.compositePreview();

          const pct = Math.round((this.currentOpIndex / this.ops.length) * 100);
          if (onProgress) onProgress(pct);

          requestAnimationFrame(checkCompletion);
        } else {
          // Finished replay, let the final frame record for 1 second
          this.compositePreview();
          if (onProgress) onProgress(100);

          setTimeout(() => {
            recorder.stop();
            this.speed = originalSpeed;
          }, 1000);
        }
      };

      requestAnimationFrame(checkCompletion);
    });
  }

  private setStatus(status: ReplayStatus) {
    this.status = status;
    if (this.options.onStatusChange) {
      this.options.onStatusChange(status);
    }
  }

  private emitProgress() {
    if (this.options.onProgress) {
      const total = this.ops.length;
      const pct = total > 0 ? Math.round((this.currentOpIndex / total) * 100) : 0;
      const currentSeq =
        this.currentOpIndex > 0 && this.ops[this.currentOpIndex - 1]
          ? this.ops[this.currentOpIndex - 1].seq
          : 0;

      this.options.onProgress({
        currentOpIndex: this.currentOpIndex,
        totalOps: total,
        currentSeq,
        progressPercent: pct,
        status: this.status,
      });
    }
  }

  public destroy() {
    this.stop();
    this.layerCanvases.clear();
  }
}
