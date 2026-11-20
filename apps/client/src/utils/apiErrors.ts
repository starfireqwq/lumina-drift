import type { Translations } from '../locales';

/** Error text for a failed API request: the server's own message when it sent one, else a localized one. */
export function apiErrorMessage(text: Translations['server'], status: number, body: unknown): string {
  const data = body && typeof body === 'object' ? (body as { error?: unknown; message?: unknown }) : {};
  const serverMessage = [data.error, data.message].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (serverMessage) return serverMessage;
  return status === 404 ? text.apiNotFound : text.apiRequestFailed.replace('{status}', String(status));
}
