import { describe, expect, it } from 'vitest';
import { EgressPolicy, normalizeHost } from './egress.js';
import { EgressDeniedError } from './errors.js';

const policy = new EgressPolicy({
  allowedHosts: ['data.sec.gov', 'WWW.SEC.GOV.', 'host.docker.internal'],
  allowHttpHosts: ['host.docker.internal'],
  allowedWsHostSuffixes: ['.schwab.com'],
  allowedPorts: { 'host.docker.internal': [18789] },
});

describe('EgressPolicy', () => {
  it('allows exact https hosts (case/trailing-dot normalized) for GET', () => {
    expect(policy.isAllowed('https://data.sec.gov/submissions/CIK0001113809.json')).toBe(true);
    expect(policy.isAllowed('https://www.sec.gov/Archives/x')).toBe(true);
  });

  it('denies unknown hosts, subdomains, other schemes and credentials-in-URL', () => {
    expect(policy.isAllowed('https://evil.example/')).toBe(false);
    expect(policy.isAllowed('https://sub.data.sec.gov/')).toBe(false);
    expect(policy.isAllowed('https://data.sec.gov.evil.example/')).toBe(false);
    expect(policy.isAllowed('ftp://data.sec.gov/')).toBe(false);
    expect(policy.isAllowed('https://user:pw@data.sec.gov/')).toBe(false);
    expect(policy.isAllowed('not a url')).toBe(false);
  });

  it('plain http is never allowed for GET, and only for allowHttpHosts on POST', () => {
    expect(policy.isAllowed('http://data.sec.gov/', 'get')).toBe(false);
    expect(policy.isAllowed('http://host.docker.internal:18789/hooks/scout', 'get')).toBe(false);
    expect(policy.isAllowed('http://host.docker.internal:18789/hooks/scout', 'post')).toBe(true);
    expect(policy.isAllowed('http://data.sec.gov/x', 'post')).toBe(false);
    expect(policy.isAllowed('https://data.sec.gov/x', 'post')).toBe(true);
  });

  it('ws: wss to allowed host or suffix; ws:// only for allowHttpHosts; suffix does not apply to GET', () => {
    expect(policy.isAllowed('wss://data.sec.gov/ws', 'ws')).toBe(true);
    expect(policy.isAllowed('wss://streamer-api.schwab.com/ws', 'ws')).toBe(true);
    expect(policy.isAllowed('wss://evilschwab.com/ws', 'ws')).toBe(false);
    expect(policy.isAllowed('wss://streamer-api.schwab.com/ws', 'get')).toBe(false);
    expect(policy.isAllowed('ws://host.docker.internal/x', 'ws')).toBe(true);
    expect(policy.isAllowed('ws://data.sec.gov/x', 'ws')).toBe(false);
  });

  it('assert throws EgressDeniedError with a redacted URL', () => {
    try {
      policy.assert('https://evil.example/p?api_key=SECRET', 'get');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EgressDeniedError);
      expect((e as Error).message).not.toContain('SECRET');
    }
  });

  it('pins the PORT: only the scheme default, or an explicitly allowed port for that host', () => {
    expect(policy.isAllowed('https://data.sec.gov:443/x')).toBe(true); // explicit default port
    expect(policy.isAllowed('https://data.sec.gov:8443/x')).toBe(false);
    expect(policy.isAllowed('wss://streamer-api.schwab.com:8443/ws', 'ws')).toBe(false);
    expect(policy.isAllowed('http://host.docker.internal:18789/hooks/scout', 'post')).toBe(true);
    expect(policy.isAllowed('http://host.docker.internal:18790/hooks/scout', 'post')).toBe(false);
    expect(policy.isAllowed('http://host.docker.internal/x', 'post')).toBe(true); // default :80
    expect(policy.isAllowed('https://data.sec.gov:18789/x')).toBe(false); // the exception is per host
    try {
      policy.assert('https://data.sec.gov:8443/x', 'get');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('port 8443');
    }
  });

  it('normalizeHost drops case and one trailing dot', () => {
    expect(normalizeHost('Data.SEC.gov.')).toBe('data.sec.gov');
    expect(policy.isAllowed('https://data.sec.gov./x')).toBe(true);
  });

  it('postPathAllowlist: a POST needs a listed host AND path (exact, or prefix when the entry ends in *)', () => {
    const p = new EgressPolicy({
      allowedHosts: ['api.schwabapi.com', 'host.docker.internal', 'ntfy.sh', 'data.sec.gov'],
      allowHttpHosts: ['host.docker.internal'],
      allowedPorts: { 'host.docker.internal': [18789] },
      postPathAllowlist: {
        'api.schwabapi.com': ['/v1/oauth/token'],
        'host.docker.internal': ['/hooks/*'],
        'ntfy.sh': ['/'],
      },
    });
    expect(p.isAllowed('https://api.schwabapi.com/v1/oauth/token', 'post')).toBe(true);
    expect(p.isAllowed('https://api.schwabapi.com/v1/oauth/token/', 'post')).toBe(true);
    // any other Schwab path is denied for POST even though the host is allowlisted (read-only guarantee)
    expect(p.isAllowed('https://api.schwabapi.com/trader/v1/accounts/abc/anything', 'post')).toBe(
      false,
    );
    expect(p.isAllowed('https://api.schwabapi.com/v1/oauth/token/../x', 'post')).toBe(false);
    expect(p.isAllowed('https://api.schwabapi.com/v1/oauth/tokenx', 'post')).toBe(false);
    expect(p.isAllowed('http://host.docker.internal:18789/hooks/scout', 'post')).toBe(true);
    expect(p.isAllowed('http://host.docker.internal:18789/other', 'post')).toBe(false);
    expect(p.isAllowed('https://ntfy.sh/', 'post')).toBe(true);
    expect(p.isAllowed('https://ntfy.sh/some-topic', 'post')).toBe(false); // JSON to the base URL only
    expect(p.isAllowed('https://data.sec.gov/x', 'post')).toBe(false); // host without an entry
    expect(p.isAllowed('https://api.schwabapi.com/trader/v1/accounts', 'get')).toBe(true); // GET unaffected
    expect(
      new EgressPolicy({ allowedHosts: ['a.example'], postPathAllowlist: {} }).isAllowed(
        'https://a.example/x',
        'post',
      ),
    ).toBe(false);
    try {
      p.assert('https://data.sec.gov/x', 'post');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('no POST path allowlist entry');
    }
  });

  it('validates construction and lists hosts', () => {
    expect(() => new EgressPolicy({ allowedHosts: [] })).toThrow(RangeError);
    expect(
      () =>
        new EgressPolicy({ allowedHosts: ['a.example'], allowedWsHostSuffixes: ['schwab.com'] }),
    ).toThrow(RangeError);
    expect(policy.hostList()).toEqual(['data.sec.gov', 'host.docker.internal', 'www.sec.gov']);
  });
});
