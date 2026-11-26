/**
 * The ONE module allowed to read `process.env` (policy test enforces this) and the only reader of the secrets
 * file. A CLOSED allowlist of key names: anything else in the file is ignored (and reported by NAME only, to
 * catch typos). Values are never returned by `report()`, never logged, never serialized.
 *
 * Why a file: umbrelOS 1.x does not inject the app-data `.env` into containers (decision D30), so unattended
 * Scout reads `/data/secrets/scout.env` (mode 0600, excluded from backups). `process.env` is a FALLBACK for
 * local development; a non-empty environment value wins over the file.
 *
 * Pattern adapted from BlackGold packages/core/src/config/load.ts (MIT, Copyright (c) 2026 Matt Herman):
 * closed allowlist + env-only-in-one-module. Changes: file-mode check, `SecretsView` with a value-free report,
 * inspection/serialization guards.
 */
import fs from 'node:fs';
import { inspect } from 'node:util';
import { SecretsError } from '../core/errors.js';

/** Every secret/credential key Scout may read. Adding one is a security-relevant change: edit here AND README. */
export const SECRET_KEYS = [
  /** REQUIRED for any SEC call: contact (email) placed in the SEC User-Agent. No default (decision D2). */
  'SCOUT_SEC_CONTACT',
  'SCHWAB_CLIENT_ID',
  'SCHWAB_CLIENT_SECRET',
  /** Must be https and match the registered redirect URL exactly. */
  'SCHWAB_REDIRECT_URI',
  'ANTHROPIC_API_KEY',
  /** Dedicated OpenClaw `hooks.token` (distinct from the gateway token). */
  'OPENCLAW_HOOK_TOKEN',
  'OPENCLAW_HOOK_URL',
  'NTFY_URL',
  'NTFY_TOPIC',
  'NTFY_TOKEN',
  'FRED_API_KEY',
  'FINRA_CLIENT_ID',
  'FINRA_CLIENT_SECRET',
  'IMAP_HOST',
  'IMAP_USER',
  'IMAP_PASS',
  /** Optional extra salt mixed into API-token hashes. */
  'SCOUT_API_TOKEN_PEPPER',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(SECRET_KEYS);

/** What modules receive. Values flow only through `get`/`require`; `report()` is value-free. */
export interface SecretsView {
  /** The value, or undefined when unset/empty. */
  get(key: SecretKey): string | undefined;
  /** The value. @throws SecretsError naming the KEY (never a value) when unset. */
  require(key: SecretKey): string;
  isSet(key: SecretKey): boolean;
  report(): SecretsReport;
  /**
   * A view limited to `keys`: `get`/`require`/`isSet` of any other key THROW a `SecretsError` (a programmer
   * error, caught by the first test that runs the code), so the composition root can hand the RSS adapter a view
   * that cannot read `ANTHROPIC_API_KEY`. "Credentials THIS adapter owns" is enforced, not an honor system.
   */
  scope(keys: readonly SecretKey[]): SecretsView;
}

export interface SecretsReport {
  /** Which allowlisted keys are set (true/false only). */
  keys: Record<SecretKey, boolean>;
  set: SecretKey[];
  unset: SecretKey[];
  /**
   * Non-allowlisted key NAMES found in the file (ignored). Names only, and only names shaped like an env var
   * (`^[A-Z][A-Z0-9_]{0,63}$`); anything else (a pasted base64 value ending in `=` parses as a "key") is
   * reported as `<malformed line N>` so no fragment of a credential ever reaches doctor/health output.
   */
  ignored: string[];
  file: { path: string | null; state: 'loaded' | 'absent' | 'none' };
}

class Secrets implements SecretsView {
  readonly #values: ReadonlyMap<SecretKey, string>;
  readonly #ignored: readonly string[];
  readonly #file: SecretsReport['file'];
  /** When set, only these keys are visible through this view. */
  readonly #scope: ReadonlySet<SecretKey> | null;

  constructor(
    values: ReadonlyMap<SecretKey, string>,
    ignored: readonly string[],
    file: SecretsReport['file'],
    scope: ReadonlySet<SecretKey> | null = null,
  ) {
    this.#values = values;
    this.#ignored = ignored;
    this.#file = file;
    this.#scope = scope;
  }

  #check(key: SecretKey): void {
    if (this.#scope !== null && !this.#scope.has(key)) {
      throw new SecretsError(`Secret ${key} is not granted to this component`, { key });
    }
  }

  scope(keys: readonly SecretKey[]): SecretsView {
    for (const k of keys) {
      if (!KEY_SET.has(k)) throw new SecretsError(`Unknown secret key ${k}`, { key: k });
      this.#check(k); // a scoped view can only narrow, never widen
    }
    return new Secrets(this.#values, this.#ignored, this.#file, new Set(keys));
  }

  get(key: SecretKey): string | undefined {
    this.#check(key);
    return this.#values.get(key);
  }

  require(key: SecretKey): string {
    this.#check(key);
    const v = this.#values.get(key);
    if (v === undefined) {
      throw new SecretsError(`Required secret ${key} is not set (secrets file or environment)`, {
        key,
      });
    }
    return v;
  }

  isSet(key: SecretKey): boolean {
    this.#check(key);
    return this.#values.has(key);
  }

  report(): SecretsReport {
    const visible = SECRET_KEYS.filter((k) => this.#scope === null || this.#scope.has(k));
    const keys = {} as Record<SecretKey, boolean>;
    for (const k of SECRET_KEYS)
      keys[k] = this.#scope === null || this.#scope.has(k) ? this.#values.has(k) : false;
    return {
      keys,
      set: visible.filter((k) => keys[k]),
      unset: visible.filter((k) => !keys[k]),
      ignored: [...this.#ignored],
      file: { ...this.#file },
    };
  }

  toJSON(): SecretsReport {
    return this.report();
  }

  [inspect.custom](): string {
    return `[Secrets: ${this.#values.size}/${SECRET_KEYS.length} set]`;
  }
}

export interface LoadSecretsOptions {
  /** Secrets file path (default none: environment only). */
  path?: string;
  /** Environment fallback (default `process.env`; this is the only module allowed to default to it). */
  env?: Record<string, string | undefined>;
  /** Refuse a secrets file readable by group/others (default true; skipped on Windows). */
  strictPermissions?: boolean;
}

/** Parse dotenv-style text into raw key/value pairs (comments, `export`, quotes supported). */
export function parseEnvFile(text: string): Map<string, string> {
  return new Map(parseEnvLines(text).map((e) => [e.key, e.value]));
}

/** Like {@link parseEnvFile} but keeps the 1-based line number of each entry (later entries override earlier). */
function parseEnvLines(text: string): { key: string; value: string; line: number }[] {
  const out = new Map<string, { key: string; value: string; line: number }>();
  const lines = text.split(/\r?\n/);
  for (const [idx, rawLine] of lines.entries()) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.set(key, { key, value, line: idx + 1 });
  }
  return [...out.values()];
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Load secrets: file first, then a non-empty environment value overrides per key.
 *
 * @throws SecretsError when the file exists but is unreadable, or is group/other-accessible while
 *   `strictPermissions` is on (the message names the path and the fix, never a value).
 *
 * @example
 * ```ts
 * const secrets = loadSecrets({ path: '/data/secrets/scout.env' }); // entry point
 * const ua = buildUserAgent('scout-edgar', secrets.require('SCOUT_SEC_CONTACT'));
 * ```
 */
export function loadSecrets(options: LoadSecretsOptions = {}): SecretsView {
  const env = options.env ?? process.env;
  const values = new Map<SecretKey, string>();
  const ignored: string[] = [];
  let state: SecretsReport['file']['state'] = options.path === undefined ? 'none' : 'absent';

  if (options.path !== undefined) {
    let text: string | undefined;
    try {
      if ((options.strictPermissions ?? true) && process.platform !== 'win32') {
        const mode = fs.statSync(options.path).mode;
        if ((mode & 0o077) !== 0) {
          throw new SecretsError(
            `Secrets file ${options.path} is accessible by group/others (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${options.path}`,
          );
        }
      }
      text = fs.readFileSync(options.path, 'utf8');
    } catch (err) {
      if (err instanceof SecretsError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const hint =
          (err as NodeJS.ErrnoException).code === 'EACCES'
            ? ` (permission denied: the container runs as uid 1000; run: chown 1000:1000 ${options.path} && chmod 600 ${options.path})`
            : '';
        throw new SecretsError(
          `Could not read secrets file ${options.path}: ${(err as Error).message}${hint}`,
          {
            cause: err,
          },
        );
      }
    }
    if (text !== undefined) {
      state = 'loaded';
      for (const { key: k, value: v, line } of parseEnvLines(text)) {
        if (KEY_SET.has(k)) {
          if (v !== '') values.set(k as SecretKey, v);
        } else ignored.push(ENV_NAME.test(k) ? k : `<malformed line ${line}>`);
      }
    }
  }

  for (const k of SECRET_KEYS) {
    const v = env[k];
    if (v !== undefined && v !== '') values.set(k, v);
  }
  return new Secrets(values, ignored, { path: options.path ?? null, state });
}

/** Build a view from literal values (tests, `scout doctor` dry runs). Unknown keys are rejected. */
export function createSecrets(values: Partial<Record<SecretKey, string>> = {}): SecretsView {
  const map = new Map<SecretKey, string>();
  for (const [k, v] of Object.entries(values)) {
    if (!KEY_SET.has(k)) throw new SecretsError(`Unknown secret key ${k}`, { key: k });
    if (v !== undefined && v !== '') map.set(k as SecretKey, v);
  }
  return new Secrets(map, [], { path: null, state: 'none' });
}
