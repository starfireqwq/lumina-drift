export function parseServerLink(raw: string): URL | null {
  const value = raw.trim();
  if (!value || /[\s\\]/.test(value)) return null;
  const hasHttp = /^https?:\/\//i.test(value);
  if (!hasHttp && /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
  try {
    const url = new URL(hasHttp ? value : `http://${value}`);
    if (url.username || url.password) return null;
    if (!hasHttp && !url.port && publicServerOrigin(url.origin)) {
      url.protocol = 'https:';
    }
    return url;
  } catch {
    return null;
  }
}

export function publicServerOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.replace(/\.$/, '');
    if (/\.(?:localhost|local|lan|internal|home\.arpa)$/.test(host)) return null;
    if (host.startsWith('[')) {
      // Global unicast IPv6 addresses begin with 2 or 3.
      return /^\[[23]/.test(host) ? url.origin : null;
    }
    if (!host.includes('.')) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [first, second] = host.split('.').map(Number);
      if (first === 0 || first === 10 || first === 127 || first >= 224 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)) return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isLoopbackServer(value: string): boolean {
  const host = parseServerLink(value)?.hostname;
  return Boolean(host && (host === 'localhost' || host === '[::1]' || /^127\./.test(host)));
}

export function buildRoomShareUrl(baseUrl: string, canvasId?: string | null, preview?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!canvasId || /^(offline-|local_)/.test(canvasId)) return trimmed;
  const params = new URLSearchParams({ room: canvasId });
  if (preview) params.set('preview', preview);
  try {
    const url = new URL(trimmed);
    for (const [key, value] of params) url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return `${trimmed}/?${params}`;
  }
}

export function sharedRoomFromLocation(): string | null {
  if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol)) return null;
  const room = new URLSearchParams(window.location.search).get('room');
  return room && /^[\w-]{1,128}$/.test(room) && !room.startsWith('offline-') ? room : null;
}
