import {
  LayerModel,
  decompressTileBuffer,
  DEFAULT_TILE_SIZE,
  renderVectorStrokeToCanvas,
} from '@atelier/shared';
import { animationDisplay } from './AnimationEngine';
import { compositeLayers, type LayerCanvasItem } from './layerComposite';
import { ApiService } from '../services/api';
import { getUserColor } from '../utils/userColors';
import {
  computeSeekReplayPlan,
  extractOpCursorTarget,
  normalizeReplayTileBytes,
  ReplayParticipantInfo,
  resolveTileDimensions,
  unpremultiplyRgba,
} from './timeLapseHelpers';
import {
  buildVideoRecorderCandidates,
  createMediaRecorderForStream,
  createScaledRecordingSurface,
  stopMediaStream,
  unwrapMediaRecorderError,
  type VideoRecorderCandidate,
} from './videoExport';

export type ReplayStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'completed'
  | 'recording'
  | 'error';

export type { ReplayParticipantInfo } from './timeLapseHelpers';

export interface ReplayProgress {
  currentOpIndex: number;
  totalOps: number;
  currentSeq: number;
  progressPercent: number;
  status: ReplayStatus;
  loadedOps?: number;
  expectedTotalOps?: number;
  error?: string | null;
}

export interface ReplayEngineOptions {
  onProgress?: (progress: ReplayProgress) => void;
  onStatusChange?: (status: ReplayStatus) => void;
  onParticipantsChange?: (participants: ReplayParticipantInfo[]) => void;
  showCursors?: boolean;
}

export interface SeedParticipantInput {
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  color?: string | null;
}

interface ReplayCursorState {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  color: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  brushSize: number;
  brushColor: string;
  isEraser: boolean;
  isDrawing: boolean;
  lastOpIndex: number;
  lastActiveAt: number;
}

const CURSOR_HOLD_MS = 1000;
const CURSOR_FADE_MS = 700;
const CURSOR_WINDOW_OPS = 25;

export class TimeLapseEngine {
  private canvasId: string = '';
  private width: number = 2048;
  private height: number = 2048;
  private bgColor: string = '#FFFFFF';
  private layers: LayerModel[] = [];
  private knownLayerIds: Set<string> = new Set();
  private ops: any[] = [];

  // Rendering canvases
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private layerCanvases: Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> = new Map();
  private emptyCanvas: HTMLCanvasElement;

  // Tile decode pooling
  private scratchRgba = new Uint8Array(DEFAULT_TILE_SIZE * DEFAULT_TILE_SIZE * 4);
  private imageDataPool: Map<string, ImageData> = new Map();

  // Participants, avatars & active painter cursors
  private seedParticipants: Map<string, SeedParticipantInput> = new Map();
  private participants: Map<string, ReplayParticipantInfo> = new Map();
  private avatarImages: Map<string, HTMLImageElement | 'loading' | 'error'> = new Map();
  private activeCursors: Map<string, ReplayCursorState> = new Map();
  private showCursors: boolean = true;

  // Loading & error state
  private abortController: AbortController | null = null;
  private loadedOps: number = 0;
  private expectedTotalOps: number = 0;
  private errorMessage: string | null = null;

  // Playback state
  private status: ReplayStatus = 'idle';
  private currentOpIndex: number = 0;
  private speed: number = 4;
  private animationFrameId: number | null = null;
  private lastStepTimestamp: number = 0;

  // Video recording
  private mediaRecorder: MediaRecorder | null = null;
  private recordingStream: MediaStream | null = null;
  private recordingCancelled: boolean = false;
  private recordedChunks: Blob[] = [];

  private options: ReplayEngineOptions;

  constructor(previewCanvas: HTMLCanvasElement, options: ReplayEngineOptions = {}) {
    this.previewCanvas = previewCanvas;
    const ctx = previewCanvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D rendering context for preview canvas');
    this.previewCtx = ctx;
    this.options = options;
    this.showCursors = options.showCursors ?? true;
    this.emptyCanvas = document.createElement('canvas');
    this.emptyCanvas.width = 1;
    this.emptyCanvas.height = 1;
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

  public getError(): string | null {
    return this.errorMessage;
  }

  public getParticipants(): ReplayParticipantInfo[] {
    return Array.from(this.participants.values()).sort(
      (a, b) => (b.opCount ?? 0) - (a.opCount ?? 0)
    );
  }

  public setShowCursors(show: boolean) {
    if (this.showCursors === show) return;
    this.showCursors = show;
    this.compositePreview();
  }

  public setSeedParticipants(entries: SeedParticipantInput[]) {
    this.seedParticipants.clear();
    for (const entry of entries) {
      if (!entry?.userId) continue;
      this.seedParticipants.set(entry.userId, entry);
      const existing = this.participants.get(entry.userId);
      if (existing) {
        if (!existing.displayName || existing.displayName === '畫師') {
          if (entry.displayName) existing.displayName = entry.displayName;
        }
        if (!existing.avatarUrl && entry.avatarUrl) {
          existing.avatarUrl = entry.avatarUrl;
          this.preloadAvatar(entry.userId, entry.avatarUrl);
        }
        if (entry.color) existing.color = entry.color;
      }
    }
    this.options.onParticipantsChange?.(this.getParticipants());
  }

  /**
   * Initializes and loads all operations for a canvas via paginated MessagePack streaming
   */
  public async loadCanvasHistory(
    canvasId: string,
    width: number,
    height: number,
    bgColor: string,
    layers: LayerModel[],
    seedParticipants: SeedParticipantInput[] = []
  ): Promise<number> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    this.stop();
    this.canvasId = canvasId;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.bgColor = bgColor || '#FFFFFF';
    this.layers = [...layers].sort((a, b) => a.sortOrder - b.sortOrder);
    this.knownLayerIds = new Set(this.layers.map((l) => l.id));
    this.layerCanvases.clear();
    this.imageDataPool.clear();
    this.activeCursors.clear();
    this.participants.clear();
    this.loadedOps = 0;
    this.expectedTotalOps = 0;
    this.errorMessage = null;
    this.ops = [];

    this.setSeedParticipants(seedParticipants);

    this.previewCanvas.width = this.width;
    this.previewCanvas.height = this.height;
    this.clearAll();
    this.setStatus('loading');
    this.emitProgress();

    try {
      const res = await ApiService.getTimeLapseOps(canvasId, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (controller.signal.aborted) return;
          this.loadedOps = loaded;
          this.expectedTotalOps = total;
          this.emitProgress();
        },
      });

      if (controller.signal.aborted) return 0;

      this.ops = Array.isArray(res?.ops) ? res.ops : [];
      this.loadedOps = this.ops.length;
      this.expectedTotalOps = this.ops.length;
      this.buildParticipantsIndex(res?.participants || {});
      this.currentOpIndex = 0;
      this.setStatus(this.ops.length > 0 ? 'paused' : 'idle');
      this.emitProgress();
      return this.ops.length;
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        return 0;
      }
      console.error('[TimeLapseEngine] Failed to fetch operations history:', err);
      this.ops = [];
      this.errorMessage = err?.message || '載入歷史操作日誌失敗，請稍後重試';
      this.currentOpIndex = 0;
      this.setStatus('error');
      this.emitProgress();
      return 0;
    }
  }

  private buildParticipantsIndex(
    serverParticipants: Record<string, { userId: string; displayName: string; avatarUrl: string | null }>
  ) {
    this.participants.clear();
    const counts = new Map<string, number>();
    for (const op of this.ops) {
      if (!op?.userId) continue;
      counts.set(op.userId, (counts.get(op.userId) ?? 0) + 1);
    }

    const allIds = new Set<string>([
      ...Object.keys(serverParticipants),
      ...counts.keys(),
    ]);

    for (const userId of allIds) {
      const serverInfo = serverParticipants[userId];
      const seedInfo = this.seedParticipants.get(userId);
      const displayName =
        (seedInfo?.displayName && seedInfo.displayName !== '畫師' ? seedInfo.displayName : null) ||
        serverInfo?.displayName ||
        seedInfo?.displayName ||
        '畫師';
      const avatarUrl = serverInfo?.avatarUrl ?? seedInfo?.avatarUrl ?? null;
      const color = seedInfo?.color || getUserColor(userId).hex;
      const info: ReplayParticipantInfo = {
        userId,
        displayName,
        avatarUrl,
        color,
        opCount: counts.get(userId) ?? 0,
      };
      this.participants.set(userId, info);
      if (avatarUrl) {
        this.preloadAvatar(userId, avatarUrl);
      }
    }

    this.options.onParticipantsChange?.(this.getParticipants());
  }

  private resolveParticipant(userId: string, op?: any): ReplayParticipantInfo {
    let info = this.participants.get(userId);
    if (!info) {
      const seed = this.seedParticipants.get(userId);
      info = {
        userId: userId || 'unknown',
        displayName: seed?.displayName || op?.displayName || '畫師',
        avatarUrl: seed?.avatarUrl ?? null,
        color: seed?.color || getUserColor(userId).hex,
        opCount: 0,
      };
      this.participants.set(info.userId, info);
      if (info.avatarUrl) this.preloadAvatar(info.userId, info.avatarUrl);
    }
    return info;
  }

  private preloadAvatar(userId: string, avatarUrl: string) {
    if (typeof Image === 'undefined' || !avatarUrl) return;
    const prev = this.avatarImages.get(userId);
    if (prev && prev !== 'error') {
      if (prev instanceof HTMLImageElement && prev.src === avatarUrl) return;
    }
    this.avatarImages.set(userId, 'loading');
    const img = new Image();
    if (!avatarUrl.startsWith('data:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      this.avatarImages.set(userId, img);
      if (this.status === 'paused' || this.status === 'completed') {
        this.compositePreview();
      }
    };
    img.onerror = () => {
      this.avatarImages.set(userId, 'error');
    };
    img.src = avatarUrl;
  }

  private ensureLayerCanvas(layerId: string): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    const existing = this.layerCanvases.get(layerId);
    if (existing) return existing;

    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const entry = { canvas: c, ctx };
    this.layerCanvases.set(layerId, entry);

    // Ensure layers deleted/merged later in history still appear during replay
    if (!this.knownLayerIds.has(layerId)) {
      this.knownLayerIds.add(layerId);
      const maxOrder = this.layers.reduce((acc, l) => Math.max(acc, l.sortOrder), 0);
      this.layers.push({
        id: layerId,
        canvasId: this.canvasId,
        parentId: null,
        ownerId: null,
        name: '歷史圖層',
        layerType: 'raster',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        isLocked: false,
        alphaLocked: false,
        clipToBelow: false,
        sortOrder: maxOrder + 10,
        aclMode: 'shared_all',
        isPublic: true,
        createdAt: 0,
        updatedAt: 0,
      });
    }

    return entry;
  }

  /**
   * Clears all layer canvases and draws base canvas
   */
  private clearAll() {
    for (const { ctx } of this.layerCanvases.values()) {
      ctx.clearRect(0, 0, this.width, this.height);
    }
    this.activeCursors.clear();
    this.compositePreview();
  }

  /**
   * Composites all visible layer canvases onto the main preview canvas,
   * followed by active collaborator brush cursors (with avatars & names).
   */
  private compositePreview(now = performance.now()) {
    const shown = animationDisplay(this.layers, null, this.width, this.height);
    const items: LayerCanvasItem[] = [];
    for (const layer of shown) {
      if (layer.layerType === 'mask') continue;
      const maskLayer = this.layers.find((m) => m.layerType === 'mask' && m.parentId === layer.id);
      const maskCanvas = maskLayer && this.layerCanvases.get(maskLayer.id)?.canvas;
      items.push({
        layer,
        canvas: this.layerCanvases.get(layer.id)?.canvas ?? this.emptyCanvas,
        mask: maskLayer && maskCanvas
          ? {
              canvas: maskCanvas,
              enabled: maskLayer.isVisible,
              inverted: Boolean(maskLayer.meta?.maskInverted),
            }
          : undefined,
      });
    }
    compositeLayers(items, this.width, this.height, this.bgColor, this.previewCanvas);

    if (this.showCursors && this.activeCursors.size > 0) {
      this.drawPainterCursors(now);
    }
  }

  private updateCursorForOp(op: any, opIndex: number, now: number, instant = false) {
    if (!op?.userId) return;
    const target = extractOpCursorTarget(op, this.width, this.height);
    const info = this.resolveParticipant(op.userId, op);
    const existing = this.activeCursors.get(op.userId);

    if (!target) {
      if (existing) {
        existing.lastOpIndex = opIndex;
        existing.lastActiveAt = now;
      }
      return;
    }

    if (existing) {
      existing.displayName = info.displayName;
      existing.avatarUrl = info.avatarUrl;
      existing.color = info.color;
      if (instant) {
        existing.x = target.x;
        existing.y = target.y;
      } else {
        // Blend cleanly toward the new stroke position so brushes glide naturally
        existing.x = existing.x + (target.x - existing.x) * 0.55;
        existing.y = existing.y + (target.y - existing.y) * 0.55;
      }
      existing.targetX = target.x;
      existing.targetY = target.y;
      existing.brushSize = target.brushSize;
      existing.brushColor = target.brushColor;
      existing.isEraser = target.isEraser;
      existing.isDrawing = true;
      existing.lastOpIndex = opIndex;
      existing.lastActiveAt = now;
    } else {
      const startPt = target.points[0] ?? { x: target.x, y: target.y };
      this.activeCursors.set(op.userId, {
        userId: op.userId,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
        color: info.color,
        x: instant ? target.x : startPt.x,
        y: instant ? target.y : startPt.y,
        targetX: target.x,
        targetY: target.y,
        brushSize: target.brushSize,
        brushColor: target.brushColor,
        isEraser: target.isEraser,
        isDrawing: true,
        lastOpIndex: opIndex,
        lastActiveAt: now,
      });
    }
  }

  private stepCursorSmoothing(now: number) {
    const isLivePlayback = this.status === 'playing' || this.status === 'recording';
    for (const [uid, cursor] of this.activeCursors.entries()) {
      cursor.x += (cursor.targetX - cursor.x) * 0.45;
      cursor.y += (cursor.targetY - cursor.y) * 0.45;
      if (isLivePlayback) {
        const ageMs = now - cursor.lastActiveAt;
        if (ageMs > CURSOR_HOLD_MS + CURSOR_FADE_MS && this.currentOpIndex - cursor.lastOpIndex > CURSOR_WINDOW_OPS) {
          this.activeCursors.delete(uid);
        } else {
          cursor.isDrawing = ageMs < 350 || this.currentOpIndex - cursor.lastOpIndex <= 2;
        }
      }
    }
  }

  private drawPainterCursors(now: number) {
    const ctx = this.previewCtx;
    const maxDim = Math.max(this.width, this.height);
    const uiScale = Math.max(0.75, Math.min(3.5, maxDim / 1000));
    const isLivePlayback = this.status === 'playing' || this.status === 'recording';

    const cursors = Array.from(this.activeCursors.values()).sort(
      (a, b) => a.lastOpIndex - b.lastOpIndex
    );

    for (const cursor of cursors) {
      let alpha = 1;
      if (isLivePlayback) {
        const ageMs = now - cursor.lastActiveAt;
        if (ageMs > CURSOR_HOLD_MS) {
          alpha = Math.max(0, 1 - (ageMs - CURSOR_HOLD_MS) / CURSOR_FADE_MS);
        }
      }
      if (alpha <= 0.02) continue;

      ctx.save();
      ctx.globalAlpha = alpha;

      // 1. Brush footprint ring
      const ringRadius = Math.max(
        5 * uiScale,
        Math.min(110 * uiScale, (cursor.brushSize || 12) / 2)
      );
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, ringRadius, 0, Math.PI * 2);
      ctx.fillStyle = cursor.isEraser ? 'rgba(255,255,255,0.22)' : `${cursor.color}33`;
      ctx.fill();
      ctx.lineWidth = 1.5 * uiScale;
      ctx.setLineDash([4 * uiScale, 3 * uiScale]);
      ctx.strokeStyle = cursor.isEraser ? 'rgba(30,41,59,0.85)' : cursor.color;
      ctx.stroke();
      ctx.setLineDash([]);

      // 2. Pointer arrow tip at (cursor.x, cursor.y)
      ctx.save();
      ctx.translate(cursor.x, cursor.y);
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 4 * uiScale;
      ctx.shadowOffsetY = 1.5 * uiScale;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 16 * uiScale);
      ctx.lineTo(4.5 * uiScale, 12.2 * uiScale);
      ctx.lineTo(8.5 * uiScale, 19.5 * uiScale);
      ctx.lineTo(11.2 * uiScale, 18 * uiScale);
      ctx.lineTo(7.2 * uiScale, 11 * uiScale);
      ctx.lineTo(12.5 * uiScale, 10.5 * uiScale);
      ctx.closePath();
      ctx.fillStyle = cursor.color;
      ctx.fill();
      ctx.lineWidth = 1.6 * uiScale;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
      ctx.restore();

      // 3. Name + Avatar badge pill
      const fontSize = Math.round(11 * uiScale);
      const avatarSize = Math.round(18 * uiScale);
      const padX = Math.round(6 * uiScale);
      const padY = Math.round(4 * uiScale);
      const gap = Math.round(5 * uiScale);
      const label = cursor.displayName || '畫師';
      const toolSuffix = cursor.isEraser ? ' ⌫' : '';

      ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const textWidth = ctx.measureText(label + toolSuffix).width;
      const pillW = padX * 2 + avatarSize + gap + textWidth;
      const pillH = avatarSize + padY * 2;
      const margin = 6 * uiScale;

      let pillX = cursor.x + 12 * uiScale;
      let pillY = cursor.y + 16 * uiScale;
      if (pillX + pillW > this.width - margin) {
        pillX = Math.max(margin, cursor.x - pillW - 8 * uiScale);
      }
      if (pillY + pillH > this.height - margin) {
        pillY = Math.max(margin, cursor.y - pillH - 8 * uiScale);
      }
      pillX = Math.max(margin, Math.min(this.width - pillW - margin, pillX));
      pillY = Math.max(margin, Math.min(this.height - pillH - margin, pillY));

      const radius = pillH / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 6 * uiScale;
      ctx.shadowOffsetY = 2 * uiScale;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, radius);
      ctx.fillStyle = cursor.color;
      ctx.fill();
      ctx.lineWidth = 1.2 * uiScale;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.stroke();
      ctx.restore();

      // Avatar circle
      const avCx = pillX + padX + avatarSize / 2;
      const avCy = pillY + pillH / 2;
      const avR = avatarSize / 2;
      const imgEntry = this.avatarImages.get(cursor.userId);
      const hasLoadedImg =
        imgEntry instanceof HTMLImageElement && imgEntry.complete && imgEntry.naturalWidth > 0;

      ctx.save();
      ctx.beginPath();
      ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
      ctx.clip();
      if (hasLoadedImg) {
        const iw = imgEntry.naturalWidth;
        const ih = imgEntry.naturalHeight;
        const side = Math.min(iw, ih);
        const sx = (iw - side) / 2;
        const sy = (ih - side) / 2;
        ctx.drawImage(
          imgEntry,
          sx,
          sy,
          side,
          side,
          avCx - avR,
          avCy - avR,
          avatarSize,
          avatarSize
        );
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(avCx - avR, avCy - avR, avatarSize, avatarSize);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `800 ${Math.round(fontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label.charAt(0).toUpperCase(), avCx, avCy + 0.5 * uiScale);
      }
      ctx.restore();

      // White ring around avatar
      ctx.beginPath();
      ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
      ctx.lineWidth = 1.2 * uiScale;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.stroke();

      // Display name text
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label + toolSuffix, pillX + padX + avatarSize + gap, pillY + pillH / 2 + 0.5 * uiScale);

      ctx.restore();
    }
  }

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
    if (this.status !== 'loading' && this.status !== 'error') {
      this.setStatus('paused');
    }
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
    if (this.status !== 'loading' && this.status !== 'error') {
      this.setStatus('paused');
    }
    this.emitProgress();
  }

  /**
   * Seeks to a specific operation index using deduplicated tile replay
   */
  public seek(targetIndex: number) {
    const wasPlaying = this.status === 'playing';
    this.pause();

    const clamped = Math.max(0, Math.min(targetIndex, this.ops.length));
    this.clearAll();

    const plan = computeSeekReplayPlan(this.ops, clamped);
    for (const op of plan.sequentialOps) {
      this.executeOp(op);
    }
    for (const entry of plan.latestTiles) {
      const targetLayer = this.ensureLayerCanvas(entry.layerId);
      if (targetLayer) {
        this.applyTileToContext(targetLayer.ctx, entry.tile);
      }
    }

    // Reconstruct recent active painter cursors at the target frame
    const now = performance.now();
    const startCursorIdx = Math.max(0, clamped - CURSOR_WINDOW_OPS);
    for (let i = startCursorIdx; i < clamped; i++) {
      this.updateCursorForOp(this.ops[i], i, now, true);
    }

    this.currentOpIndex = clamped;
    this.compositePreview(now);

    if (wasPlaying && clamped < this.ops.length) {
      this.play();
    } else {
      this.setStatus(clamped >= this.ops.length && this.ops.length > 0 ? 'completed' : 'paused');
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
      const baseDelay = 30 / this.speed;
      let executedAny = false;

      if (elapsed >= baseDelay || this.speed >= 16) {
        const opsToProcess = this.speed >= 16 ? Math.min(Math.floor(this.speed / 4), 24) : 1;

        for (let i = 0; i < opsToProcess; i++) {
          if (this.currentOpIndex < this.ops.length) {
            const op = this.ops[this.currentOpIndex];
            this.executeOp(op);
            this.updateCursorForOp(op, this.currentOpIndex, timestamp);
            this.currentOpIndex++;
            executedAny = true;
          } else {
            break;
          }
        }

        this.lastStepTimestamp = timestamp;
      }

      this.stepCursorSmoothing(timestamp);
      if (executedAny || (this.showCursors && this.activeCursors.size > 0)) {
        this.compositePreview(timestamp);
      }
      if (executedAny) {
        this.emitProgress();
      }

      if (this.currentOpIndex >= this.ops.length) {
        this.compositePreview(timestamp);
        this.setStatus('completed');
        this.emitProgress();
        return;
      }

      this.scheduleNextStep();
    });
  }

  private getPooledImageData(width: number, height: number): ImageData {
    const key = `${width}x${height}`;
    let imgData = this.imageDataPool.get(key);
    if (!imgData) {
      imgData = new ImageData(width, height);
      this.imageDataPool.set(key, imgData);
    }
    return imgData;
  }

  private applyTileToContext(ctx: CanvasRenderingContext2D, t: any) {
    if (!t || !t.data) return;
    const dim = resolveTileDimensions(t, this.width, this.height);
    if (!dim) return;

    try {
      const bytes = normalizeReplayTileBytes(t.data);
      if (bytes.length === 0) return;
      const expectedLen = dim.width * dim.height * 4;
      const compression = t.compression || 'lz4';
      const rawBytes =
        compression === 'lz4'
          ? decompressTileBuffer(bytes, 'lz4', expectedLen, this.scratchRgba)
          : bytes.subarray(0, expectedLen);
      if (rawBytes.length < expectedLen) return;

      const imgData = this.getPooledImageData(dim.width, dim.height);
      unpremultiplyRgba(rawBytes.subarray(0, expectedLen), imgData.data);
      ctx.putImageData(imgData, dim.x, dim.y);
    } catch {
      // Skip corrupt tile
    }
  }

  /**
   * Executes a single operation on the designated layer canvas
   */
  private executeOp(op: any) {
    if (!op || !op.layerId) return;

    const targetLayer = this.ensureLayerCanvas(op.layerId);
    if (!targetLayer) return;

    const { ctx } = targetLayer;
    const payload = op.payload;
    const opType = (op.opType || '').toUpperCase();

    if (opType === 'LAYER_CLEAR') {
      ctx.clearRect(0, 0, this.width, this.height);
      return;
    }

    // 1. Authoritative pixel-perfect tile restoration whenever tiles are present
    // (Covers modern STROKE, ERASE, TILE_PATCH, SMART_FILL, FILL, FILTER, LIQUIFY, VECTOR_EDIT, UNDO/REDO)
    if (Array.isArray(payload?.tiles) && payload.tiles.length > 0) {
      for (const t of payload.tiles) {
        this.applyTileToContext(ctx, t);
      }
      return;
    }

    // 2. Legacy STROKE / ERASE fallback without tiles
    if ((opType === 'STROKE' || opType === 'ERASE') && Array.isArray(payload?.samplePoints) && payload.samplePoints.length > 0) {
      const samplePoints = payload.samplePoints;
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
      } else {
        for (let i = 0; i < samplePoints.length - 1; i++) {
          const p1 = samplePoints[i];
          const p2 = samplePoints[i + 1];
          const avgPressure = ((p1.pressure || 0.5) + (p2.pressure || 0.5)) / 2;
          ctx.lineWidth = Math.max(1, brushSize * avgPressure);

          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();

          const r = ctx.lineWidth / 2;
          ctx.beginPath();
          ctx.arc(p2.x, p2.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      return;
    }

    // 3. Vector strokes fallback when tiles are absent
    const addedVectors = Array.isArray(payload?.vectorAdded)
      ? payload.vectorAdded
      : payload?.vectorStroke
        ? [payload.vectorStroke]
        : null;
    if (addedVectors && addedVectors.length > 0) {
      for (const s of addedVectors) {
        try {
          renderVectorStrokeToCanvas(ctx, s);
        } catch {
          // Skip malformed vector stroke
        }
      }
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

    const candidates = buildVideoRecorderCandidates(this.width, this.height, format);
    const originalSpeed = this.speed;
    this.recordingCancelled = false;
    let lastError: Error | null = null;

    try {
      for (let i = 0; i < candidates.length; i++) {
        if (this.recordingCancelled) {
          throw new Error('縮時影片匯出已取消');
        }
        try {
          return await this.recordTimeLapseAttempt(candidates[i], onProgress);
        } catch (err) {
          lastError = unwrapMediaRecorderError(err);
          if (this.recordingCancelled || i === candidates.length - 1) {
            throw lastError;
          }
          console.warn(
            `[TimeLapseEngine] Video candidate failed (${candidates[i].mimeType || 'default'} ${candidates[i].width}x${candidates[i].height}), trying fallback:`,
            lastError.message
          );
        }
      }
      throw lastError ?? new Error('無法初始化視訊編碼器');
    } finally {
      this.speed = originalSpeed;
    }
  }

  private async recordTimeLapseAttempt(
    candidate: VideoRecorderCandidate,
    onProgress?: (percent: number) => void
  ): Promise<Blob> {
    this.pause();
    this.seek(0);
    this.setStatus('recording');

    const surface = createScaledRecordingSurface(this.previewCanvas, candidate.width, candidate.height);
    surface.syncFrame();

    const stream = surface.canvas.captureStream(30);
    this.recordingStream = stream;
    this.recordedChunks = [];

    let recorder: MediaRecorder;
    try {
      recorder = createMediaRecorderForStream(stream, candidate.mimeType, 6000000);
    } catch (err) {
      stopMediaStream(stream);
      this.recordingStream = null;
      this.setStatus('paused');
      this.emitProgress();
      throw unwrapMediaRecorderError(err);
    }

    this.mediaRecorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    return new Promise<Blob>((resolve, reject) => {
      let settled = false;
      let rafId: number | null = null;
      let stopTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (stopTimer !== null) {
          clearTimeout(stopTimer);
          stopTimer = null;
        }
        stopMediaStream(stream);
        if (this.recordingStream === stream) {
          this.recordingStream = null;
        }
        if (this.mediaRecorder === recorder) {
          this.mediaRecorder = null;
        }
      };

      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.recordingCancelled) {
          reject(new Error('縮時影片匯出已取消'));
          return;
        }
        const blobType = recorder.mimeType || candidate.mimeType || 'video/webm';
        const finalBlob = new Blob(this.recordedChunks, { type: blobType });
        if (finalBlob.size === 0) {
          this.setStatus('paused');
          this.emitProgress();
          reject(new Error(`視訊編碼器未輸出有效影像資料 (${blobType})`));
          return;
        }
        this.setStatus('completed');
        this.emitProgress();
        resolve(finalBlob);
      };

      recorder.onerror = (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.setStatus('paused');
        this.emitProgress();
        reject(unwrapMediaRecorderError(e));
      };

      try {
        recorder.start(100);
      } catch (err) {
        settled = true;
        cleanup();
        this.setStatus('paused');
        this.emitProgress();
        reject(unwrapMediaRecorderError(err));
        return;
      }

      this.speed = 16;
      const batch = Math.max(2, Math.min(48, Math.ceil(this.ops.length / 360)));

      const checkCompletion = (now: number) => {
        if (settled || this.recordingCancelled || this.status !== 'recording') {
          return;
        }
        if (this.currentOpIndex < this.ops.length) {
          for (let b = 0; b < batch && this.currentOpIndex < this.ops.length; b++) {
            const op = this.ops[this.currentOpIndex];
            this.executeOp(op);
            this.updateCursorForOp(op, this.currentOpIndex, now);
            this.currentOpIndex++;
          }
          this.stepCursorSmoothing(now);
          this.compositePreview(now);
          surface.syncFrame();
          this.emitProgress();

          const pct = Math.round((this.currentOpIndex / this.ops.length) * 100);
          if (onProgress) onProgress(pct);

          rafId = requestAnimationFrame(checkCompletion);
        } else {
          this.compositePreview(now);
          surface.syncFrame();
          if (onProgress) onProgress(100);

          stopTimer = setTimeout(() => {
            if (settled) return;
            if (recorder.state === 'recording') {
              try {
                recorder.requestData();
              } catch {
                // Ignore if requestData is unsupported right before stop
              }
              recorder.stop();
            }
          }, 1000);
        }
      };

      rafId = requestAnimationFrame(checkCompletion);
    });
  }

  private setStatus(status: ReplayStatus) {
    this.status = status;
    this.options.onStatusChange?.(status);
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
        loadedOps: this.loadedOps,
        expectedTotalOps: this.expectedTotalOps,
        error: this.errorMessage,
      });
    }
  }

  public destroy() {
    this.recordingCancelled = true;
    this.abortController?.abort();
    this.abortController = null;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignore recorder stop failures during teardown
      }
    }
    stopMediaStream(this.recordingStream);
    this.recordingStream = null;
    this.stop();
    this.layerCanvases.clear();
    this.imageDataPool.clear();
    this.activeCursors.clear();
    this.avatarImages.clear();
  }
}
