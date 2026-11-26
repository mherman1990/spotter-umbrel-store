/**
 * Redaction helpers: scrub secrets out of URLs, free text, and structured log objects.
 *
 * Unlike BlackGold's `redact()` (which THROWS on any text containing "token" or a dollar amount), these never
 * throw and never reject legitimate alert text: Scout alerts legitimately say "Schwab token expires in 24h"
 * and "$250,000 sale". They only replace credential-shaped VALUES (query params, bearer strings, long keys).
 * (Decision D17.)
 */

/** Placeholder written in place of a removed secret. */
export const REDACTED = '[REDACTED]';

/** Query-parameter names whose values are always redacted (case-insensitive). */
export const SECRET_QUERY_PARAMS: readonly string[] = [
  'api_key',
  'apikey',
  'api-key',
  'key',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'secret',
  'password',
  'code',
  'authorization',
  'sig',
  'signature',
];

/** Header names that must never be logged with their value (case-insensitive). */
export const SECRET_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-openclaw-token',
  'cookie',
  'set-cookie',
];

/**
 * Object-key paths for pino's `redact` option. pino has no regex support, so common nestings are listed
 * explicitly (top level, one level deep, request/response headers).
 */
export const REDACT_PATHS: readonly string[] = buildRedactPaths();

function buildRedactPaths(): string[] {
  const keys = [
    'authorization',
    'Authorization',
    'token',
    'access_token',
    'accessToken',
    'refresh_token',
    'refreshToken',
    'id_token',
    'secret',
    'client_secret',
    'clientSecret',
    'api_key',
    'apiKey',
    'apikey',
    'password',
    'pass',
    'cookie',
    'Cookie',
  ];
  const headerKeys = [
    'authorization',
    'Authorization',
    'cookie',
    'Cookie',
    'x-api-key',
    'x-openclaw-token',
  ];
  const out: string[] = [];
  for (const k of keys) {
    out.push(k, `*.${k}`, `*.*.${k}`);
  }
  for (const h of headerKeys) {
    out.push(`headers["${h}"]`, `*.headers["${h}"]`, `req.headers["${h}"]`, `res.headers["${h}"]`);
  }
  return out;
}

export interface RedactUrlOptions {
  /**
   * Path segments that ARE a credential (e.g. the topic of a public ntfy server: the topic is the only secret,
   * and it travels in the URL path). Any path segment equal to one of these (after percent-decoding) is
   * replaced by the placeholder in the returned string.
   */
  secretPathSegments?: readonly string[];
}

/** Return `url` with credential-bearing query values and userinfo removed. Unparseable input is returned scrubbed as text. */
export function redactUrl(url: string, options: RedactUrlOptions = {}): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return redactText(url);
  }
  if (u.username !== '' || u.password !== '') {
    u.username = '';
    u.password = '';
  }
  const secret = new Set(SECRET_QUERY_PARAMS);
  for (const name of [...u.searchParams.keys()]) {
    if (secret.has(name.toLowerCase())) u.searchParams.set(name, REDACTED);
  }
  const secretSegments = new Set((options.secretPathSegments ?? []).filter((s) => s !== ''));
  if (secretSegments.size > 0) {
    u.pathname = u.pathname
      .split('/')
      .map((seg) => (secretSegments.has(safeDecode(seg)) ? REDACTED : seg))
      .join('/');
  }
  // URL percent-encodes the brackets in the placeholder; restore it for readability.
  return u.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Stricter list for FREE TEXT (ordinary words such as "code=200" or "key=abc" must survive). */
const TEXT_SECRET_PARAMS = [
  'api_key',
  'apikey',
  'api-key',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'password',
  'authorization',
];
const KV = new RegExp(
  `\\b(${TEXT_SECRET_PARAMS.map((p) => p.replace(/[-_]/g, '[-_]')).join('|')})=([^&\\s"']+)`,
  'gi',
);
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{8,}/g;

/**
 * Scrub credential-shaped values out of arbitrary text: `Bearer xxx`, `Basic xxx`, `api_key=xxx`, Anthropic
 * `sk-ant-...` keys. Idempotent. Does NOT touch ordinary words like "token" or dollar amounts.
 */
export function redactText(text: string): string {
  return text
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KV, (_m, name: string) => `${name}=${REDACTED}`)
    .replace(ANTHROPIC_KEY, REDACTED);
}

/** Copy of `headers` safe to log: secret header values replaced. Keys are lower-cased. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const secret = new Set(SECRET_HEADERS);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = secret.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}
