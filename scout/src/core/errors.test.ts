import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  AuthExpiredError,
  ConfigError,
  EgressDeniedError,
  HttpError,
  HttpNetworkError,
  HttpTimeoutError,
  LlmBudgetExceededError,
  LlmUnavailableError,
  MigrationError,
  NotifyError,
  ReadOnlyViolationError,
  ResponseTooLargeError,
  ScoutError,
  SecretsError,
  describeCause,
  isRetryable,
} from './errors.js';

describe('error hierarchy', () => {
  it('every error is a ScoutError with a stable code and its own class name', () => {
    const errors: ScoutError[] = [
      new ConfigError('x'),
      new SecretsError('x', { key: 'ANTHROPIC_API_KEY' }),
      new EgressDeniedError('https://evil.example/'),
      new ReadOnlyViolationError('x'),
      new HttpError('https://a.example/', 500),
      new HttpTimeoutError('https://a.example/', 1000),
      new HttpNetworkError('https://a.example/', new Error('boom')),
      new ResponseTooLargeError('https://a.example/', 10, 5),
      new AuthExpiredError('schwab', 'expired'),
      new AdapterError('edgar', 'bad'),
      new MigrationError('x'),
      new LlmUnavailableError('x'),
      new LlmBudgetExceededError('daily', 5.1, 5),
      new NotifyError('ntfy', 'x'),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(ScoutError);
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toMatch(/^[A-Z_]+$/);
      expect(e.name).toBe(e.constructor.name);
    }
    expect(new EgressDeniedError('u').code).toBe('EGRESS_DENIED');
  });

  it('retryability is encoded: 5xx/429/timeouts/network yes, 4xx/config/auth no', () => {
    expect(isRetryable(new HttpError('u', 503))).toBe(true);
    expect(isRetryable(new HttpError('u', 429))).toBe(true);
    expect(isRetryable(new HttpError('u', 404))).toBe(false);
    expect(isRetryable(new HttpTimeoutError('u', 1))).toBe(true);
    expect(isRetryable(new HttpNetworkError('u', 'x'))).toBe(true);
    expect(isRetryable(new AuthExpiredError('schwab', 'x'))).toBe(false);
    expect(isRetryable(new ConfigError('x'))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });

  it('AuthExpiredError defaults to reauthRequired and carries the service', () => {
    const e = new AuthExpiredError('schwab', 'refresh token expired');
    expect(e.service).toBe('schwab');
    expect(e.reauthRequired).toBe(true);
    expect(new AuthExpiredError('finra', 'x', { reauthRequired: false }).reauthRequired).toBe(
      false,
    );
  });

  it('AdapterError prefixes the adapter id and keeps the cause', () => {
    const cause = new Error('root');
    const e = new AdapterError('edgar.submissions', 'parse failed', { cause });
    expect(e.message).toBe('[edgar.submissions] parse failed');
    expect(e.cause).toBe(cause);
    expect(e.details).toMatchObject({ adapterId: 'edgar.submissions' });
  });

  it('SecretsError carries only the KEY NAME', () => {
    const e = new SecretsError('Required secret X is not set', { key: 'X' });
    expect(e.key).toBe('X');
  });

  it('describeCause includes undici-style cause codes', () => {
    const e = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(describeCause(e)).toBe('fetch failed (ECONNREFUSED)');
    expect(describeCause('plain')).toBe('plain');
    expect(describeCause(new Error('no cause'))).toBe('no cause');
  });

  it('describeCause redacts credentials that a library echoes (undici invalid-header message)', () => {
    const e = new TypeError(
      'Headers.append: "Bearer sk-ant-api03-abcdefghijklmnop" is an invalid header value',
    );
    const out = describeCause(e);
    expect(out).not.toContain('sk-ant');
    expect(out).toContain('[REDACTED]');
    expect(describeCause('token=abc123def')).toBe('token=[REDACTED]');
    expect(new HttpNetworkError('https://x.example/', e).message).not.toContain('sk-ant');
  });

  it('LlmBudgetExceededError exposes the scope', () => {
    const e = new LlmBudgetExceededError('monthly', 50.5, 50);
    expect(e.scope).toBe('monthly');
    expect(e.message).toContain('monthly');
  });
});
