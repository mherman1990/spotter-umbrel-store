import { describe, expect, it } from 'vitest';
import { createLogger, createSilentLogger, resolveLogLevel } from './logger.js';

function capture(): { lines: string[]; stream: { write(s: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => void lines.push(s) } };
}

describe('resolveLogLevel', () => {
  it('honors a valid SCOUT_LOG_LEVEL, ignores an invalid one', () => {
    expect(resolveLogLevel({ SCOUT_LOG_LEVEL: 'DEBUG' })).toBe('debug');
    expect(resolveLogLevel({ SCOUT_LOG_LEVEL: 'loud' })).toBe('info');
  });
  it('is silent under tests and info otherwise', () => {
    expect(resolveLogLevel({ VITEST: 'true' })).toBe('silent');
    expect(resolveLogLevel({ NODE_ENV: 'test' })).toBe('silent');
    expect(resolveLogLevel({})).toBe('info');
    expect(resolveLogLevel()).toBe('info');
  });
});

describe('createLogger', () => {
  it('redacts credential keys at the top level, nested, and in headers', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });
    log.info(
      {
        authorization: 'Bearer AAA',
        token: 'BBB',
        refresh_token: 'CCC',
        client_secret: 'DDD',
        api_key: 'EEE',
        password: 'FFF',
        cookie: 'GGG',
        req: { headers: { authorization: 'Bearer HHH', cookie: 'III' } },
        nested: { access_token: 'JJJ' },
        safe: 'visible',
      },
      'hello',
    );
    const out = lines.join('');
    for (const secret of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ']) {
      expect(out, `leaked ${secret}`).not.toContain(secret);
    }
    expect(out).toContain('visible');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs credential-shaped values out of log MESSAGES and serialized errors', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });
    log.info('refresh failed: Bearer sk-ant-api03-abcdefghijklmnop was rejected');
    log.error(
      {
        err: new Error(
          'Headers.append: "Bearer sk-ant-api03-zzzzzzzzzzzz" is an invalid header value',
        ),
      },
      'boom',
    );
    log.warn({ url: 'x' }, 'token=SEKRET12345 leaked?');
    const out = lines.join('');
    expect(out).not.toContain('sk-ant');
    expect(out).not.toContain('SEKRET12345');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('boom');
  });

  it('writes nothing at silent level and supports child bindings', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'silent', destination: stream });
    log.info('x');
    expect(lines).toHaveLength(0);
    const loud = createLogger({ level: 'info', destination: stream, name: 'scout-test' });
    loud.child({ adapter: 'edgar' }).info('y');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      adapter: 'edgar',
      name: 'scout-test',
      msg: 'y',
    });
  });

  it('createSilentLogger is silent', () => {
    expect(createSilentLogger().level).toBe('silent');
  });
});
