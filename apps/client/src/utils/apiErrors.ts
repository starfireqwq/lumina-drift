import type { Translations } from '../locales';

const isJsonType = (contentType: string | null | undefined) => /\bjson\b/i.test(contentType ?? '');

/**
 * True when a reply to an /api call clearly did not come from a Lumina server: a static host's 404 page,
 * or its single-page fallback answering with the app's HTML. A Lumina server always answers /api in JSON.
 */
export function isForeignApiReply(status: number, contentType: string | null | undefined): boolean {
  if (status === 404) return true;
  return status >= 200 && status < 300 && !isJsonType(contentType);
}

/** Error text for a failed API request: the server's own message when it sent one, else a localized one. */
export function apiErrorMessage(text: Translations['server'], status: number, body: unknown): string {
  const data = body && typeof body === 'object' ? (body as { error?: unknown; message?: unknown }) : {};
  const serverMessage = [data.error, data.message].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (serverMessage) return serverMessage;
  return status === 404 ? text.apiNotFound : text.apiRequestFailed.replace('{status}', String(status));
}
