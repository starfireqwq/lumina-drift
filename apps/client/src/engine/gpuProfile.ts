export interface DeviceEnvironment {
  userAgent?: string;
  platform?: string;
  deviceMemory?: number;
  coarsePointer?: boolean;
  screenMinSide?: number;
  maxTouchPoints?: number;
}

interface TestOverrides {
  __ATELIER_FORCE_MAX_TEXTURE_SIZE__?: number;
  __ATELIER_TEST_DEVICE_PROFILE__?: DeviceEnvironment;
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1;

export function queryMaxTextureSize(renderer?: unknown): number {
  type Context = Pick<WebGLRenderingContext, 'getParameter' | 'MAX_TEXTURE_SIZE'>;
  const pixi = renderer as { gl?: Context; context?: { gl?: Context } } | undefined;
  let actual: unknown;
  try {
    for (const gl of [pixi?.gl, pixi?.context?.gl]) {
      actual = gl?.getParameter(gl.MAX_TEXTURE_SIZE);
      if (positive(actual)) break;
    }
  } catch {
    // The context may be lost or unavailable during renderer initialization.
  }
  const forced = (globalThis as TestOverrides).__ATELIER_FORCE_MAX_TEXTURE_SIZE__;
  const limit = positive(actual) ? actual : Infinity;
  return Math.floor(positive(forced) ? Math.min(forced, limit) : positive(actual) ? actual : 4096);
}

export function detectConstrainedDevice(env?: DeviceEnvironment) {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const screen = globalThis.screen;
  const device = env ?? (globalThis as TestOverrides).__ATELIER_TEST_DEVICE_PROFILE__ ?? {
    userAgent: nav?.userAgent,
    platform: nav?.platform,
    deviceMemory: nav?.deviceMemory,
    coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches,
    screenMinSide: screen && Math.min(screen.width, screen.height),
    maxTouchPoints: nav?.maxTouchPoints,
  };
  const ua = device.userAgent ?? '';
  const isAndroid = /Android/i.test(ua);
  const isMobileOrTablet = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    ((device.platform === 'MacIntel' || /Macintosh/i.test(ua)) && (device.maxTouchPoints ?? 0) > 1) ||
    Boolean(device.coarsePointer) || (positive(device.screenMinSide) && device.screenMinSide < 768);
  const deviceMemoryGb = positive(device.deviceMemory) ? device.deviceMemory : 8;
  return { isMobileOrTablet, isAndroid, isConstrained: isMobileOrTablet || deviceMemoryGb <= 4, deviceMemoryGb };
}

export function computeSafeDisplayResolution(
  canvasWidth: number, canvasHeight: number, rawDpr: number, profile: ReturnType<typeof detectConstrainedDevice>,
): number {
  const pixels = canvasWidth * canvasHeight;
  let cap = 2;
  if (profile.isMobileOrTablet) cap = pixels >= 48_000_000 ? 1 : pixels >= 16_000_000 ? 1.25 : 1.5;
  else if (profile.deviceMemoryGb <= 4 && pixels >= 48_000_000) cap = 1.5;
  return Math.min(Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1, cap);
}

export function canAllocateFullCanvasTexture(width: number, height: number, maxTextureSize: number, isConstrained: boolean): boolean {
  if (!positive(width) || !positive(height) || width > maxTextureSize || height > maxTextureSize || !positive(maxTextureSize)) return false;
  const bytes = width * height * 4;
  return isConstrained ? bytes < 64 * 1048576 : bytes <= 256 * 1048576;
}

export function computeSafeTextureScale(width: number, height: number, maxTextureSize: number, maxPixels = Infinity) {
  width = positive(width) ? width : 1;
  height = positive(height) ? height : 1;
  const side = positive(maxTextureSize) ? Math.floor(maxTextureSize) : 1;
  const pixels = Math.max(1, Math.floor(maxPixels) || 1);
  const scale = Math.min(1, side / width, side / height, Math.sqrt(pixels / (width * height)));
  let outW = Math.max(1, Math.floor(width * scale));
  let outH = Math.max(1, Math.floor(height * scale));
  // A subpixel short side becomes one texel and can otherwise push thin rectangles over budget.
  outW = Math.min(side, outW, Math.floor(pixels / outH) || 1);
  outH = Math.min(side, outH, Math.floor(pixels / outW));
  return { width: outW, height: outH, scale: Math.min(scale, outW / width, outH / height) };
}
