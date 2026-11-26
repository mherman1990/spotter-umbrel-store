/**
 * The egress allowlist policy shared by every outbound path (GET client, POST client, WebSocket factory).
 * Decision D7/D8: every host Scout may talk to is NAMED in coverage.yaml (`egress`) and README; anything else
 * throws {@link EgressDeniedError} BEFORE a connection is attempted.
 *
 * Beyond the host, the policy also pins:
 *  - the PORT: only the scheme's default port, unless the host has an explicit entry in `allowedPorts` (the
 *    OpenClaw gateway on `:18789` is the one exception; the composition root derives `allowedPorts` from the
 *    ports that appear in coverage endpoint URLs, so `https://data.sec.gov:8443/x` is denied);
 *  - the PATH of every POST when `postPathAllowlist` is given (defense in depth for the read-only guarantee,
 *    decision D6: the ONLY POST that can reach Schwab is the OAuth token endpoint, enforced here and not only
 *    by a source-code grep).
 */
import { EgressDeniedError } from './errors.js';
import { redactUrl } from './redact.js';

export interface EgressPolicyOptions {
  /** Exact hostnames (lower-case, no scheme/port), e.g. `data.sec.gov`. Subdomains are NOT implied. */
  allowedHosts: readonly string[];
  /**
   * Hosts additionally permitted over PLAIN http/ws (private-network services only: the OpenClaw gateway at
   * `host.docker.internal`, a LAN ntfy). Must also appear in `allowedHosts`.
   */
  allowHttpHosts?: readonly string[];
  /**
   * Dot-prefixed host suffixes for WebSocket endpoints whose exact host is only learned at runtime
   * (e.g. `.schwab.com`, `.schwabapi.com` for the Schwab streamer URL, decision D13). Applies to wss only.
   */
  allowedWsHostSuffixes?: readonly string[];
  /**
   * Non-default ports permitted per host (`{ 'host.docker.internal': [18789] }`). A URL whose explicit port
   * is neither the scheme default (443 for https/wss, 80 for http/ws) nor listed here is denied.
   */
  allowedPorts?: Readonly<Record<string, readonly number[]>>;
  /**
   * POST path allowlist per host. When PROVIDED (even empty) every POST must target a listed host AND a listed
   * path: an entry ending in `*` is a prefix (`/hooks/*`), any other entry matches the exact path (a trailing
   * slash on the request is ignored, so `/` means the root only). A POST to an unlisted host is denied. Omit
   * for no path restriction (tests, the GET client). Example built by the composition root:
   * `{ 'api.schwabapi.com': ['/v1/oauth/token'], 'host.docker.internal': ['/hooks/scout', '/hooks/agent'] }`.
   */
  postPathAllowlist?: Readonly<Record<string, readonly string[]>>;
}

export type EgressKind = 'get' | 'post' | 'ws';

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'https:': 443,
  'wss:': 443,
  'http:': 80,
  'ws:': 80,
};

/** Immutable allowlist checker. Construct once from config; share the instance. */
export class EgressPolicy {
  private readonly hosts: ReadonlySet<string>;
  private readonly httpHosts: ReadonlySet<string>;
  private readonly wsSuffixes: readonly string[];
  private readonly ports: ReadonlyMap<string, ReadonlySet<number>>;
  private readonly postPaths: ReadonlyMap<string, readonly string[]> | null;

  constructor(options: EgressPolicyOptions) {
    if (options.allowedHosts.length === 0)
      throw new RangeError('egress allowedHosts must not be empty');
    this.hosts = new Set(options.allowedHosts.map(normalizeHost));
    this.httpHosts = new Set((options.allowHttpHosts ?? []).map(normalizeHost));
    this.wsSuffixes = (options.allowedWsHostSuffixes ?? []).map((s) => s.toLowerCase());
    for (const s of this.wsSuffixes) {
      if (!s.startsWith('.')) throw new RangeError(`ws host suffix must start with '.': ${s}`);
    }
    this.ports = new Map(
      Object.entries(options.allowedPorts ?? {}).map(([h, ps]) => [normalizeHost(h), new Set(ps)]),
    );
    this.postPaths =
      options.postPathAllowlist === undefined
        ? null
        : new Map(
            Object.entries(options.postPathAllowlist).map(([h, ps]) => [normalizeHost(h), [...ps]]),
          );
  }

  /** Sorted list of exact allowed hosts (for `scout doctor` / README parity checks). */
  hostList(): string[] {
    return [...this.hosts].sort();
  }

  /**
   * Validate `rawUrl` for `kind` and return the parsed URL.
   * - `get`: https only. `post`: https, or http for `allowHttpHosts`. `ws`: wss, or ws for `allowHttpHosts`.
   * - Credentials embedded in the URL (`https://user:pass@host`) are always denied.
   * - Only the scheme's default port, or a port listed for the host in `allowedPorts`.
   * - `post` also needs a matching `postPathAllowlist` entry when that option is set.
   * @throws EgressDeniedError
   */
  assert(rawUrl: string, kind: EgressKind): URL {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new EgressDeniedError(redactUrl(rawUrl), 'not a valid absolute URL');
    }
    const safe = redactUrl(rawUrl);
    if (u.username !== '' || u.password !== '') {
      throw new EgressDeniedError(safe, 'URL must not embed credentials');
    }
    const host = normalizeHost(u.hostname);
    const secure = kind === 'ws' ? 'wss:' : 'https:';
    const plain = kind === 'ws' ? 'ws:' : 'http:';
    if (u.protocol === plain) {
      if (kind === 'get') throw new EgressDeniedError(safe, 'plain http is not allowed for GET');
      if (!this.httpHosts.has(host)) {
        throw new EgressDeniedError(safe, 'plain http/ws only allowed for allowHttpHosts');
      }
    } else if (u.protocol !== secure) {
      throw new EgressDeniedError(safe, `scheme ${u.protocol} is not allowed`);
    }
    const hostOk =
      this.hosts.has(host) ||
      (kind === 'ws' && u.protocol === 'wss:' && this.wsSuffixes.some((s) => host.endsWith(s)));
    if (!hostOk) throw new EgressDeniedError(safe);
    this.assertPort(u, host, safe);
    if (kind === 'post') this.assertPostPath(u, host, safe);
    return u;
  }

  private assertPort(u: URL, host: string, safe: string): void {
    if (u.port === '') return; // the scheme default (the URL parser drops it)
    const port = Number(u.port);
    if (port === DEFAULT_PORTS[u.protocol]) return;
    if (this.ports.get(host)?.has(port) === true) return;
    throw new EgressDeniedError(safe, `port ${port} is not allowed for this host`);
  }

  private assertPostPath(u: URL, host: string, safe: string): void {
    if (this.postPaths === null) return;
    const allowed = this.postPaths.get(host);
    if (allowed === undefined) {
      throw new EgressDeniedError(safe, 'no POST path allowlist entry for this host');
    }
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname;
    const ok = allowed.some((entry) =>
      entry.endsWith('*')
        ? u.pathname.startsWith(entry.slice(0, -1))
        : path === (entry.length > 1 ? entry.replace(/\/$/, '') : entry),
    );
    if (!ok)
      throw new EgressDeniedError(safe, `POST path ${u.pathname} is not allowed for this host`);
  }

  /** Non-throwing variant of {@link assert}. */
  isAllowed(rawUrl: string, kind: EgressKind = 'get'): boolean {
    try {
      this.assert(rawUrl, kind);
      return true;
    } catch {
      return false;
    }
  }
}

/** Lower-case a hostname and drop one trailing dot (`data.sec.gov.` and `data.sec.gov` are the same host). */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}
