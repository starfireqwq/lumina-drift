import { Container, Point } from 'pixi.js';
import { computePanForCanvasCenter } from '../utils/navigatorMath';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

export interface ViewportState {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number; // in radians
  mirrorX: boolean; // horizontal flip
  mirrorY?: boolean; // vertical flip
}

export class CanvasViewport {
  public rootContainer: Container;
  public canvasContainer: Container;

  private canvasWidth: number;
  private canvasHeight: number;
  /** Physical pixels per CSS pixel (window.devicePixelRatio / Pixi renderer resolution) */
  private displayScale = 1;

  private state: ViewportState = {
    zoom: 1.0,
    panX: 0,
    panY: 0,
    rotation: 0,
    mirrorX: false,
    mirrorY: false,
  };

  private onChangeCallback?: (state: ViewportState) => void;

  constructor(canvasWidth: number, canvasHeight: number) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;

    this.rootContainer = new Container();
    this.canvasContainer = new Container();
    this.rootContainer.addChild(this.canvasContainer);

    // Set pivot to center of canvas so rotation and mirror flip are centered
    this.canvasContainer.pivot.set(canvasWidth / 2, canvasHeight / 2);

    this.updateTransform();
  }

  public setOnChange(cb: (state: ViewportState) => void) {
    this.onChangeCallback = cb;
  }

  public getState(): ViewportState {
    return { ...this.state, mirrorY: Boolean(this.state.mirrorY) };
  }

  public setState(next: Partial<ViewportState>) {
    if (next.zoom !== undefined && Number.isFinite(next.zoom)) {
      this.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next.zoom));
    }
    if (next.panX !== undefined && Number.isFinite(next.panX)) this.state.panX = next.panX;
    if (next.panY !== undefined && Number.isFinite(next.panY)) this.state.panY = next.panY;
    if (next.rotation !== undefined && Number.isFinite(next.rotation)) this.state.rotation = next.rotation;
    if (next.mirrorX !== undefined) this.state.mirrorX = Boolean(next.mirrorX);
    if (next.mirrorY !== undefined) this.state.mirrorY = Boolean(next.mirrorY);
    this.updateTransform();
  }

  public setCanvasDimensions(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.canvasContainer.pivot.set(width / 2, height / 2);
    this.updateTransform();
  }

  public setDisplayScale(scale: number) {
    if (Number.isFinite(scale) && scale > 0 && scale !== this.displayScale) {
      this.displayScale = scale;
      this.updateTransform();
    }
  }

  public getDisplayScale(): number {
    return this.displayScale;
  }

  /** CSS zoom value where 1 canvas pixel equals 1 physical monitor pixel (CSP / Photoshop 100%). */
  public getActualSizeZoom(): number {
    return 1 / this.displayScale;
  }

  public updateTransform(snapToPixels = true) {
    const { zoom, panX, panY, rotation, mirrorX, mirrorY } = this.state;
    const scaleX = mirrorX ? -zoom : zoom;
    const scaleY = mirrorY ? -zoom : zoom;

    // At 1:1 physical scale (unrotated), snap canvas origin to the physical pixel grid so 100% view
    // never suffers half-pixel bilinear blur.
    if (snapToPixels && Math.abs(rotation) < 1e-4 && Math.abs(zoom * this.displayScale - 1) < 1e-3) {
      const res = this.displayScale;
      const halfX = (this.canvasWidth % 2) * 0.5 * scaleX;
      const halfY = (this.canvasHeight % 2) * 0.5 * scaleY;
      const sx = Math.round((panX - halfX) * res) / res + halfX;
      const sy = Math.round((panY - halfY) * res) / res + halfY;
      this.canvasContainer.position.set(sx, sy);
    } else {
      this.canvasContainer.position.set(panX, panY);
    }
    this.canvasContainer.scale.set(scaleX, scaleY);
    this.canvasContainer.rotation = rotation;

    if (this.onChangeCallback) {
      this.onChangeCallback(this.getState());
    }
  }

  /**
   * Centers the canvas in a viewport of width x height
   */
  private fitZoom(viewWidth: number, viewHeight: number) {
    const padding = Math.min(60, viewWidth / 8, viewHeight / 8);
    const scaleX = Math.max(1, viewWidth - padding * 2) / this.canvasWidth;
    const scaleY = Math.max(1, viewHeight - padding * 2) / this.canvasHeight;
    return Math.min(scaleX, scaleY, 1.5 / this.displayScale);
  }

  /** True while the view is still exactly "fit to a viewWidth × viewHeight view" (untouched by the user). */
  public isFitTo(viewWidth: number, viewHeight: number) {
    const s = this.state;
    return Math.abs(s.zoom - this.fitZoom(viewWidth, viewHeight)) < 1e-4
      && Math.abs(s.panX - viewWidth / 2) < 0.5 && Math.abs(s.panY - viewHeight / 2) < 0.5
      && s.rotation === 0 && !s.mirrorX && !s.mirrorY;
  }

  public centerInView(viewWidth: number, viewHeight: number, fit: boolean = true) {
    const zoom = fit ? this.fitZoom(viewWidth, viewHeight) : this.getActualSizeZoom();

    this.state.zoom = zoom;
    this.state.panX = viewWidth / 2;
    this.state.panY = viewHeight / 2;
    this.state.rotation = 0;
    this.state.mirrorX = false;
    this.state.mirrorY = false;

    this.updateTransform();
  }

  /**
   * Pan viewport by delta screen pixels
   */
  public panBy(deltaX: number, deltaY: number) {
    this.state.panX += deltaX;
    this.state.panY += deltaY;
    this.updateTransform();
  }

  public panToCanvasPoint(canvasX: number, canvasY: number, viewWidth: number, viewHeight: number) {
    const { panX, panY } = computePanForCanvasCenter(
      canvasX, canvasY, this.state, viewWidth, viewHeight, this.canvasWidth, this.canvasHeight,
    );
    if (!Number.isFinite(panX) || !Number.isFinite(panY)) return;
    this.state.panX = panX;
    this.state.panY = panY;
    // At 1:1 an arbitrary canvas point can require a fractional-pixel origin to land at the center.
    this.updateTransform(false);
  }

  /**
   * Zoom centered at a specific screen position (e.g. mouse cursor)
   */
  public zoomAt(clientX: number, clientY: number, factor: number) {
    const oldZoom = this.state.zoom;
    const minZoom = Math.min(MIN_ZOOM, oldZoom);
    let newZoom = Math.max(minZoom, Math.min(MAX_ZOOM, oldZoom * factor));
    const oneToOne = this.getActualSizeZoom();
    // Magnetically snap to exact physical 100% when wheel-zooming into its ±3.5% neighborhood
    // so users never get stuck at 98.7% with fractional resampling blur.
    if (
      Math.abs(oldZoom - oneToOne) / oneToOne > 0.001 &&
      Math.abs(newZoom - oneToOne) / oneToOne <= 0.035
    ) {
      newZoom = oneToOne;
    }
    this.applyZoomAt(clientX, clientY, newZoom);
  }

  public setZoomPercentAt(clientX: number, clientY: number, percent: number) {
    if (!Number.isFinite(percent)) return;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, percent / 100)) * this.getActualSizeZoom();
    this.applyZoomAt(clientX, clientY, zoom);
  }

  private applyZoomAt(clientX: number, clientY: number, newZoom: number) {
    if (newZoom === this.state.zoom) return;

    const rect = this.domElement?.getBoundingClientRect();
    const x = clientX - (rect?.left ?? 0);
    const y = clientY - (rect?.top ?? 0);
    const ratio = newZoom / this.state.zoom;
    const position = this.canvasContainer.position;
    // Scaling about the pointer also preserves its anchor when rotated or mirrored.
    this.state.panX = x + (position.x - x) * ratio;
    this.state.panY = y + (position.y - y) * ratio;
    this.state.zoom = newZoom;
    this.updateTransform();
  }

  public setZoom(zoom: number) {
    this.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    this.updateTransform();
  }

  public setRotation(radians: number) {
    this.state.rotation = radians;
    this.updateTransform();
  }

  public rotateBy(deltaRadians: number) {
    this.state.rotation = (this.state.rotation + deltaRadians) % (Math.PI * 2);
    this.updateTransform();
  }

  /** Rotate about a screen position (two-finger twist): the canvas point under it stays put */
  public rotateAt(clientX: number, clientY: number, deltaRadians: number) {
    if (!deltaRadians) return;
    const rect = this.domElement?.getBoundingClientRect();
    const x = clientX - (rect?.left ?? 0);
    const y = clientY - (rect?.top ?? 0);
    const cos = Math.cos(deltaRadians);
    const sin = Math.sin(deltaRadians);
    const dx = this.state.panX - x;
    const dy = this.state.panY - y;
    this.state.panX = x + dx * cos - dy * sin;
    this.state.panY = y + dx * sin + dy * cos;
    this.state.rotation = (this.state.rotation + deltaRadians) % (Math.PI * 2);
    this.updateTransform();
  }

  public resetRotation() {
    this.state.rotation = 0;
    this.updateTransform();
  }

  public toggleMirrorX() {
    this.state.mirrorX = !this.state.mirrorX;
    this.updateTransform();
  }

  public setMirrorX(mirror: boolean) {
    this.state.mirrorX = mirror;
    this.updateTransform();
  }

  public toggleMirrorY() {
    this.setMirrorY(!this.state.mirrorY);
  }

  public setMirrorY(mirror: boolean) {
    this.state.mirrorY = mirror;
    this.updateTransform();
  }

  private domElement?: HTMLElement | HTMLCanvasElement;
  private domRect: { left: number; top: number } | null = null;
  private domRectCleanup?: () => void;

  public invalidateRect = () => {
    this.domRect = null;
  };

  public setDomElement(el: HTMLElement | HTMLCanvasElement) {
    this.domRectCleanup?.();
    this.domElement = el;
    this.domRect = null;
    if (typeof window === 'undefined') return;
    const invalidate = this.invalidateRect;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(invalidate) : null;
    ro?.observe(el);
    window.addEventListener('resize', invalidate, { passive: true });
    window.addEventListener('scroll', invalidate, { capture: true, passive: true });
    this.domRectCleanup = () => {
      ro?.disconnect();
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('scroll', invalidate, true);
    };
  }

  public destroy() {
    this.domRectCleanup?.();
    this.domRectCleanup = undefined;
  }

  /**
   * Transform screen (pointer clientX, clientY) coordinate to canvas local coordinate
   */
  public screenToCanvas(screenX: number, screenY: number): { x: number; y: number } {
    let localScreenX = screenX;
    let localScreenY = screenY;
    if (this.domElement) {
      let rect = this.domRect;
      if (!rect) {
        const r = this.domElement.getBoundingClientRect();
        rect = { left: r.left, top: r.top };
        if (r.width > 0 || r.height > 0) this.domRect = rect;
      }
      localScreenX = screenX - rect.left;
      localScreenY = screenY - rect.top;
    }
    const p = this.canvasContainer.toLocal(new Point(localScreenX, localScreenY));
    return { x: p.x, y: p.y };
  }

  /** Transform canvas-element local coordinates (0..width, 0..height) without layout reflow */
  public localToCanvas(localX: number, localY: number): { x: number; y: number } {
    const p = this.canvasContainer.toLocal(new Point(localX, localY));
    return { x: p.x, y: p.y };
  }

  /**
   * Transform canvas local coordinate to a position relative to the Pixi canvas element.
   * Deliberately NOT client coordinates: every caller places an absolutely-positioned overlay
   * (transform box, rulers, mesh, remote cursors) inside the workspace container that the canvas
   * fills, and adding the element's client offset drew them all shifted by the top bar's height.
   */
  public canvasToScreen(canvasX: number, canvasY: number): { x: number; y: number } {
    const p = this.canvasContainer.toGlobal(new Point(canvasX, canvasY));
    return { x: p.x, y: p.y };
  }
}
