import { describe, expect, it } from 'vitest';
import { REDACTED, redactHeaders, redactText, redactUrl } from './redact.js';

describe('redactUrl', () => {
  it('removes credential query values and keeps the rest', () => {
    const out = redactUrl(
      'https://api.stlouisfed.org/fred/series/observations?series_id=UMCSENT&api_key=SECRET123&file_type=json',
    );
    expect(out).not.toContain('SECRET123');
    expect(out).toContain('series_id=UMCSENT');
    expect(out).toContain(`api_key=${REDACTED}`);
  });

  it('removes userinfo and is case-insensitive on param names', () => {
    const out = redactUrl('https://user:pw@host.example/p?Access_Token=abc&x=1');
    expect(out).not.toContain('pw@');
    expect(out).not.toContain('abc');
    expect(out).toContain('x=1');
  });

  it('scrubs the OAuth code parameter', () => {
    expect(redactUrl('https://127.0.0.1:8182/?code=abcd%40&session=zz')).not.toContain('abcd');
  });

  it('falls back to text scrubbing for non-URLs', () => {
    expect(redactUrl('not a url token=zzz')).toBe(`not a url token=${REDACTED}`);
  });
});

describe('redactUrl secretPathSegments', () => {
  it('masks a path segment that IS a credential (a public ntfy topic), including when percent-encoded', () => {
    expect(
      redactUrl('https://ntfy.sh/my-secret-topic', { secretPathSegments: ['my-secret-topic'] }),
    ).toBe('https://ntfy.sh/[REDACTED]');
    expect(
      redactUrl('https://ntfy.sh/a%20b/updates?token=x', { secretPathSegments: ['a b'] }),
    ).toBe('https://ntfy.sh/[REDACTED]/updates?token=[REDACTED]');
    expect(redactUrl('https://ntfy.sh/other', { secretPathSegments: ['my-secret-topic'] })).toBe(
      'https://ntfy.sh/other',
    );
    expect(redactUrl('https://ntfy.sh/x', { secretPathSegments: [''] })).toBe('https://ntfy.sh/x');
  });
});

describe('redactText', () => {
  it('scrubs bearer/basic strings, kv credentials and Anthropic keys', () => {
    const t =
      'Authorization: Bearer abcdef123456 and Basic dXNlcjpwYXNz api_key=K1 password=p sk-ant-api03-abcdefgh12345';
    const out = redactText(t);
    expect(out).not.toMatch(/abcdef123456|dXNlcjpwYXNz|K1|sk-ant-api03/);
    expect(out).toContain(`Bearer ${REDACTED}`);
  });

  it('does NOT reject or mangle legitimate alert text (unlike BlackGold redact())', () => {
    const t = 'Schwab token expires in 24h. Insider sold $250,000 of BBW. status code=200, key=abc';
    expect(redactText(t)).toBe(t);
  });

  it('is idempotent', () => {
    const once = redactText('Bearer abcdefghijkl');
    expect(redactText(once)).toBe(once);
  });
});

describe('redactHeaders', () => {
  it('replaces secret header values and lower-cases keys', () => {
    expect(redactHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'k', Accept: 'a' })).toEqual({
      authorization: REDACTED,
      'x-api-key': REDACTED,
      accept: 'a',
    });
  });
});
