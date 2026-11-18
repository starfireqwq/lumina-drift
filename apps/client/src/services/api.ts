import {
  AuthResponse,
  CanvasDetailResponse,
  CanvasModel,
  CanvasUnit,
  CreateCanvasDto,
  CreateLayerDto,
  FolderAccessRequest,
  JoinCanvasDto,
  LayerModel,
  LoginDto,
  RegisterDto,
  TileData,
  UpdateCanvasDto,
  UpdateLayerDto,
  UserPayload,
  VectorStroke,
  clampDpi,
} from '@atelier/shared';
import { OfflineSessionStore } from './offlineStore';
import { isLoopbackServer, parseServerLink } from '../utils/serverLinks';

const API_BASE = '/api';

const UNIT_META_KEY = 'atelier_canvas_unit_meta';
type CanvasUnitMeta = { unit?: CanvasUnit; dpi?: number };
const readUnitMetaMap = (): Record<string, CanvasUnitMeta> => {
  try {
    return typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem(UNIT_META_KEY) || '{}') : {};
  } catch {
    return {};
  }
};
const saveUnitMeta = (canvasId: string, meta: CanvasUnitMeta) => {
  try {
    if (typeof localStorage === 'undefined') return;
    const all = readUnitMetaMap();
    all[canvasId] = { ...(all[canvasId] || {}), ...meta };
    localStorage.setItem(UNIT_META_KEY, JSON.stringify(all));
  } catch {}
};
const applyUnitMeta = (canvas: CanvasModel): CanvasModel => {
  const m = readUnitMetaMap()[canvas.id];
  if (!m) return canvas;
  return {
    ...canvas,
    ...(m.unit ? { unit: m.unit } : {}),
    ...(m.dpi ? { dpi: clampDpi(m.dpi) } : {}),
  };
};

export class ApiService {
  private static serverUrl: string | undefined;
  private static roomPasswords = new Map<string, string>();
  private static canvasGroupIds = new Map<string, string>();
  private static groupPasswords = new Map<string, string>();

  /** Remembers (or with null forgets) the password a user unlocked a room with, for its REST reads */
  static setRoomPassword(canvasId: string, password: string | null) {
    const groupId = this.canvasGroupIds.get(canvasId);
    const passwords = groupId ? this.groupPasswords : this.roomPasswords;
    const id = groupId || canvasId;
    if (password) passwords.set(id, password);
    else passwords.delete(id);
  }

  static getRoomPassword(canvasId: string): string | undefined {
    const groupId = this.canvasGroupIds.get(canvasId);
    return groupId ? this.groupPasswords.get(groupId) : this.roomPasswords.get(canvasId);
  }

  static async verifyCanvasPassword(canvasId: string, password: string): Promise<void> {
    await this.request(`/canvases/${encodeURIComponent(canvasId)}/layers`, {
      headers: { 'X-Room-Password': encodeURIComponent(password) },
    });
  }

  static setServerUrl(url: string) {
    let clean = parseServerLink(url)?.origin ?? '';
    if (typeof window !== 'undefined') {
      const isDesktop = this.isDesktopEnv();
      const previous = this.getServerOrigin();
      this.getToken(previous); // Assign the legacy credential to its original server before changing URLs.
      if (!isDesktop && !(window as any).atelierMobile?.isAndroid) {
        // In browser web client: if set to current origin or invalid localhost on remote host, use relative path
        if (
          clean === window.location.origin ||
          (isLoopbackServer(clean) && !isLoopbackServer(window.location.origin)) ||
          (window.location.protocol === 'https:' && clean.startsWith('http:'))
        ) {
          clean = '';
        }
      }

      if (clean) {
        localStorage.setItem('atelier_server_url', clean);
      } else {
        localStorage.removeItem('atelier_server_url');
      }
      this.serverUrl = clean;
      if (previous !== this.getServerOrigin()) {
        this.roomPasswords.clear();
        this.groupPasswords.clear();
        this.canvasGroupIds.clear();
        window.dispatchEvent(new Event('atelier:server-changed'));
      }
    }
    this.serverUrl = clean;
  }

  static isDesktopEnv(): boolean {
    return typeof window !== 'undefined' && Boolean((window as any).atelierDesktop?.isElectron);
  }

  static isLocalDesktopServer(): boolean {
    if (!this.isDesktopEnv()) return false;
    const url = this.getServerUrl();
    return !url || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
  }

  static getServerUrl(): string {
    if (typeof window === 'undefined') return '';
    if (this.serverUrl !== undefined) return this.serverUrl;
    const isDesktop = Boolean((window as any).atelierDesktop || (window as any).atelierMobile?.isAndroid);
    const raw = localStorage.getItem('atelier_server_url') || '';
    const stored = parseServerLink(raw)?.origin ?? '';
    if (!isDesktop) {
      // Discard invalid localhost/mixed-content URLs on remote client devices (phones, tablets, cloudflare)
      if (
        stored &&
        isLoopbackServer(stored) && !isLoopbackServer(window.location.origin)
      ) {
        localStorage.removeItem('atelier_server_url');
        this.serverUrl = '';
        return '';
      }
      if (stored && window.location.protocol === 'https:' && stored.startsWith('http:')) {
        localStorage.removeItem('atelier_server_url');
        this.serverUrl = '';
        return '';
      }
      if (stored === window.location.origin) return (this.serverUrl = '');
    }
    return (this.serverUrl = stored);
  }

  static getServerOrigin(base = this.getServerUrl()): string {
    if (base) return base;
    return this.isDesktopEnv() ? 'http://127.0.0.1:3000' : window.location.origin;
  }

  static setToken(token: string | null, origin = this.getServerOrigin()) {
    const key = `atelier_token:${origin}`;
    if (token) localStorage.setItem(key, token);
    else localStorage.removeItem(key);
  }

  static getToken(origin = this.getServerOrigin()): string | null {
    const scoped = localStorage.getItem(`atelier_token:${origin}`);
    const legacy = origin === this.getServerOrigin() ? localStorage.getItem('atelier_token') : null;
    if (legacy) {
      if (!scoped) this.setToken(legacy, origin);
      localStorage.removeItem('atelier_token');
    }
    return scoped ?? legacy;
  }

  static async checkServerHealth(
    targetUrl?: string
  ): Promise<{ ok: boolean; status?: string; version?: string; error?: string }> {
    try {
      const base = targetUrl !== undefined ? targetUrl.trim().replace(/\/+$/, '') : this.getServerUrl();
      const url = base ? `${base}/health` : '/health';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: true, status: data.status, version: data.version };
    } catch (err: any) {
      return { ok: false, error: err.message || '連線逾時或無法抵達伺服器' };
    }
  }

  static async getServerNetwork(
    targetUrl?: string
  ): Promise<{ addresses: Array<{ name: string; address: string; type: 'lan' | 'tailscale' | 'local' }> }> {
    const base = targetUrl !== undefined ? targetUrl.trim().replace(/\/+$/, '') : this.getServerUrl();
    const url = base ? `${base}/api/server/network` : '/api/server/network';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('無法取得伺服器網路介面');
    return await res.json();
  }

  private static async request<T>(endpoint: string, options: RequestInit = {}, base = this.getServerUrl()): Promise<T> {
    const origin = this.getServerOrigin(base);
    const isPublicAuth = ['/auth/login', '/auth/register', '/auth/guest'].includes(endpoint);
    const token = isPublicAuth ? null : this.getToken(origin);
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    // Only attach Content-Type: application/json if there is an actual request body
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    // Password rooms: guests (no membership) prove access to /layers, /snapshot, /ops with it
    const roomId = /^\/canvases\/([^/?]+)/.exec(endpoint)?.[1];
    const roomPassword = roomId && this.getRoomPassword(roomId);
    if (roomPassword && !headers['X-Room-Password']) headers['X-Room-Password'] = encodeURIComponent(roomPassword);

    const fullUrl = base ? `${base}${API_BASE}${endpoint}` : `${API_BASE}${endpoint}`;

    const res = await fetch(fullUrl, {
      ...options,
      headers,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && token && this.getToken(origin) === token) {
        this.setToken(null, origin);
        if (origin === this.getServerOrigin()) window.dispatchEvent(new Event('atelier:auth-expired'));
      }
      throw new Error(data.error || data.message || `API 請求失敗 (HTTP ${res.status})`);
    }
    return data as T;
  }

  // Auth
  static async login(dto: LoginDto): Promise<AuthResponse> {
    const base = this.getServerUrl();
    const previousToken = this.getToken(this.getServerOrigin(base));
    const res = await this.request<AuthResponse>('/auth/login', {
      method: 'POST',
      headers: previousToken ? { Authorization: `Bearer ${previousToken}` } : undefined,
      body: JSON.stringify(dto),
    }, base);
    this.setToken(res.token, this.getServerOrigin(base));
    return res;
  }

  static async register(dto: RegisterDto): Promise<AuthResponse> {
    const base = this.getServerUrl();
    const previousToken = this.getToken(this.getServerOrigin(base));
    const res = await this.request<AuthResponse>('/auth/register', {
      method: 'POST',
      headers: previousToken ? { Authorization: `Bearer ${previousToken}` } : undefined,
      body: JSON.stringify(dto),
    }, base);
    this.setToken(res.token, this.getServerOrigin(base));
    return res;
  }

  static async getMe(): Promise<{ user: UserPayload }> {
    return this.request<{ user: UserPayload }>('/auth/me');
  }

  static async updateProfile(dto: { displayName?: string; avatarUrl?: string | null }): Promise<AuthResponse> {
    const base = this.getServerUrl();
    const origin = this.getServerOrigin(base);
    const previousToken = this.getToken(origin);
    const res = await this.request<AuthResponse>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }, base);
    if (this.getToken(origin) === previousToken) this.setToken(res.token, origin);
    return res;
  }

  // Canvases
  static listFolderAccess(canvasId: string) {
    return this.request<{ requests: FolderAccessRequest[] }>(`/canvases/${canvasId}/folder-access`);
  }

  static requestFolderAccess(canvasId: string, folderId: string) {
    return this.request<{ requests: FolderAccessRequest[] }>(`/canvases/${canvasId}/layers/${folderId}/folder-access`, { method: 'POST' });
  }

  static resolveFolderAccess(canvasId: string, folderId: string, requesterId: string, approved: boolean) {
    return this.request<{ requests: FolderAccessRequest[] }>(`/canvases/${canvasId}/layers/${folderId}/folder-access/${requesterId}`, {
      method: 'PATCH', body: JSON.stringify({ approved }),
    });
  }

  static async listCanvases(): Promise<CanvasModel[]> {
    if (OfflineSessionStore.isOfflineMode()) {
      return OfflineSessionStore.listCanvases();
    }
    const origin = this.getServerOrigin();
    const res = await this.request<{ canvases: CanvasModel[] }>('/canvases');
    if (origin === this.getServerOrigin()) {
      this.canvasGroupIds = new Map(res.canvases.flatMap((canvas) => canvas.group ? [[canvas.id, canvas.group.id] as const] : []));
    }
    return res.canvases.map(applyUnitMeta);
  }

  static async createCanvas(dto: CreateCanvasDto): Promise<{ canvas: CanvasModel; layers: LayerModel[] }> {
    if (OfflineSessionStore.isOfflineMode()) {
      return OfflineSessionStore.createCanvas(dto);
    }
    const base = this.getServerUrl();
    const origin = this.getServerOrigin(base);
    if (!this.getToken(origin)) {
      const displayName =
        (typeof window !== 'undefined' && localStorage.getItem('atelier_guest_name')) || '房主畫師';
      const guestRes = await this.request<AuthResponse>('/auth/guest', {
        method: 'POST',
        body: JSON.stringify({ displayName }),
      }, base);
      this.setToken(guestRes.token, origin);
    }
    const grouped = Boolean(dto.groupId || dto.newGroupTitle);
    const res = await this.request<{
      canvas: CanvasModel;
      layers: LayerModel[];
      token?: string;
      user?: UserPayload;
    }>(grouped ? '/canvases/grouped' : '/canvases', {
      method: 'POST',
      body: JSON.stringify(dto),
    }, base);
    if (res.canvas?.group && origin === this.getServerOrigin()) this.canvasGroupIds.set(res.canvas.id, res.canvas.group.id);
    if (res.canvas && (dto.unit || dto.dpi)) {
      saveUnitMeta(res.canvas.id, { unit: dto.unit, dpi: dto.dpi });
      res.canvas = applyUnitMeta(res.canvas);
    }
    if (res.token && res.user) {
      this.setToken(res.token, origin);
      if (origin === this.getServerOrigin() && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('atelier:auth-updated', { detail: { token: res.token, user: res.user } })
        );
      }
    }
    return res;
  }

  static async getCanvas(canvasId: string): Promise<CanvasDetailResponse> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.getCanvas(canvasId);
    }
    const res = await this.request<CanvasDetailResponse>(`/canvases/${canvasId}`);
    return { ...res, canvas: applyUnitMeta(res.canvas) };
  }

  static async joinCanvas(dto: JoinCanvasDto): Promise<CanvasDetailResponse> {
    if (dto.canvasId && OfflineSessionStore.isOfflineCanvas(dto.canvasId)) {
      return OfflineSessionStore.getCanvas(dto.canvasId);
    }
    return this.request<CanvasDetailResponse>('/canvases/join', {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  }

  static async updateCanvas(canvasId: string, dto: UpdateCanvasDto): Promise<CanvasModel> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.updateCanvas(canvasId, dto);
    }
    const res = await this.request<{ canvas: CanvasModel }>(`/canvases/${canvasId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
    return res.canvas;
  }

  static async deleteCanvas(canvasId: string): Promise<void> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.deleteCanvas(canvasId);
    }
    await this.request(`/canvases/${canvasId}`, {
      method: 'DELETE',
    });
  }

  static async resizeCanvas(
    canvasId: string,
    width: number,
    height: number,
    offsetX: number = 0,
    offsetY: number = 0,
    dpi?: number,
    unit?: CanvasUnit
  ): Promise<CanvasModel> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.resizeCanvas(canvasId, width, height, offsetX, offsetY, dpi, unit);
    }
    // The server registers PATCH; POST answered "API endpoint not found"
    const res = await this.request<{ canvas: CanvasModel }>(`/canvases/${canvasId}/resize`, {
      method: 'PATCH',
      body: JSON.stringify({ width, height, offsetX, offsetY, dpi, unit }),
    });
    if (dpi || unit) saveUnitMeta(canvasId, { ...(unit ? { unit } : {}), ...(dpi ? { dpi } : {}) });
    return applyUnitMeta(res.canvas);
  }

  // Layers
  static async listLayers(canvasId: string): Promise<LayerModel[]> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.listLayers(canvasId);
    }
    const res = await this.request<{ layers: LayerModel[] }>(`/canvases/${canvasId}/layers`);
    return res.layers;
  }

  static async getLayers(canvasId: string): Promise<LayerModel[]> {
    return this.listLayers(canvasId);
  }

  static async createLayer(canvasId: string, dto: CreateLayerDto): Promise<LayerModel> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.createLayer(canvasId, dto);
    }
    const res = await this.request<{ layer: LayerModel }>(`/canvases/${canvasId}/layers`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    return res.layer;
  }

  static async updateLayer(canvasId: string, layerId: string, dto: UpdateLayerDto): Promise<LayerModel> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.updateLayer(canvasId, layerId, dto);
    }
    const res = await this.request<{ layer: LayerModel }>(`/canvases/${canvasId}/layers/${layerId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
    return res.layer;
  }

  /** Pixels written as one TILE_PATCH op (capsule restore into a canvas nobody has open) */
  static async writeLayerTiles(canvasId: string, layerId: string, tiles: TileData[], actionDesc?: string): Promise<number> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.writeLayerTiles(canvasId, layerId, tiles);
    }
    const b64 = (bytes: Uint8Array) => {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const body = { actionDesc, tiles: tiles.map((t) => ({ col: t.col, row: t.row, width: t.width, height: t.height, compression: t.compression, data: b64(t.data as Uint8Array) })) };
    const res = await this.request<{ seq: number }>(`/canvases/${canvasId}/layers/${layerId}/tiles`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.seq;
  }

  static async writeLayerVectors(canvasId: string, layerId: string, vectorAdded: VectorStroke[]): Promise<void> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.writeLayerVectors(canvasId, layerId, vectorAdded);
    }
    await this.request(`/canvases/${canvasId}/layers/${layerId}/tiles`, {
      method: 'POST',
      body: JSON.stringify({ vectorAdded }),
    });
  }

  /** withContents: a group goes with everything inside it (what the server would not delete moves up out of it) */
  static async deleteLayer(canvasId: string, layerId: string, withContents = false): Promise<{ deletedIds?: string[]; liftedIds?: string[] }> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.deleteLayer(canvasId, layerId, withContents);
    }
    return this.request<{ deletedIds?: string[]; liftedIds?: string[] }>(`/canvases/${canvasId}/layers/${layerId}${withContents ? '?contents=1' : ''}`, {
      method: 'DELETE',
    });
  }

  static async reorderLayers(canvasId: string, layerIds: string[]): Promise<LayerModel[]> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.reorderLayers(canvasId, layerIds);
    }
    const res = await this.request<{ layers: LayerModel[] }>(`/canvases/${canvasId}/layers/reorder`, {
      method: 'POST',
      body: JSON.stringify({ layerIds }),
    });
    return res.layers;
  }

  static async releaseLayer(canvasId: string, layerId: string): Promise<LayerModel> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.updateLayer(canvasId, layerId, { isPublic: true });
    }
    const res = await this.request<{ layer: LayerModel }>(`/canvases/${canvasId}/layers/${layerId}/release`, {
      method: 'POST',
    });
    return res.layer;
  }

  static async claimLayer(canvasId: string, layerId: string): Promise<LayerModel> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.updateLayer(canvasId, layerId, { isPublic: false });
    }
    const res = await this.request<{ layer: LayerModel }>(`/canvases/${canvasId}/layers/${layerId}/claim`, {
      method: 'POST',
    });
    return res.layer;
  }

  static async transferLayer(canvasId: string, layerId: string, targetUserId: string): Promise<LayerModel> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.updateLayer(canvasId, layerId, {});
    }
    const res = await this.request<{ layer: LayerModel }>(`/canvases/${canvasId}/layers/${layerId}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    });
    return res.layer;
  }

  // Ops & Snapshots (Replay & Export)
  static async getOpsSince(
    canvasId: string,
    sinceSeq: number = 0
  ): Promise<{ ops: any[]; latestSeq: number }> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.getOpsSince(canvasId, sinceSeq);
    }
    return this.request<{ ops: any[]; latestSeq: number }>(`/canvases/${canvasId}/ops?sinceSeq=${sinceSeq}`);
  }

  static async getCanvasOps(
    canvasId: string,
    sinceSeq: number = 0
  ): Promise<{ ops: any[]; latestSeq: number }> {
    return this.getOpsSince(canvasId, sinceSeq);
  }

  static async getCanvasOpsSince(
    canvasId: string,
    sinceSeq: number = 0
  ): Promise<{ ops: any[]; latestSeq: number }> {
    return this.getOpsSince(canvasId, sinceSeq);
  }

  static async getSnapshot(canvasId: string): Promise<any> {
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      return OfflineSessionStore.getSnapshot(canvasId);
    }
    return this.request<any>(`/canvases/${canvasId}/snapshot`);
  }

  static async getCanvasSnapshot(canvasId: string): Promise<any> {
    return this.getSnapshot(canvasId);
  }

  // Admin Management Console
  static async listAdminUsers(): Promise<{
    users: Array<{
      id: string;
      username: string;
      displayName: string;
      serverRole: any;
      isActive: boolean;
      isTemporaryGuest: boolean;
      createdAt: number;
      updatedAt: number;
    }>;
  }> {
    return this.request<{ users: any[] }>('/admin/users');
  }

  static async adminResetPassword(userId: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
  }

  static async adminUpdateUserRole(userId: string, serverRole: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/admin/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ serverRole }),
    });
  }

  static async adminToggleUserStatus(userId: string, isActive: boolean): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/admin/users/${userId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  static async adminRemoveGuest(userId: string): Promise<void> {
    await this.request(`/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }
}
