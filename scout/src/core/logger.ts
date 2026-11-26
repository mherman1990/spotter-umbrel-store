/**
 * pino logger factory. No module-level logger singleton exists: the composition root builds one with
 * {@link createLogger} and injects it (and `.child({ adapter })` bindings) everywhere.
 *
 * Redaction: credential-bearing keys are censored via pino's `redact` (see `REDACT_PATHS`); every string log
 * message and every serialized `err` (message + stack) additionally goes through `redactText()` here, so a
 * library error that echoes a header value (undici does) cannot put a credential into the logs.
 */
import { pino, type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { REDACT_PATHS, REDACTED, redactText } from './redact.js';

export type Logger = PinoLogger;

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export interface CreateLoggerOptions {
  /** Explicit level. When omitted, resolved from `env` via {@link resolveLogLevel}. */
  level?: LogLevel;
  /** Environment to read `SCOUT_LOG_LEVEL` / `NODE_ENV` / `VITEST` from. Pass `process.env` from the entry point. */
  env?: Record<string, string | undefined>;
  /** Logger name (`name` field on every line). Default `scout`. */
  name?: string;
  /** Where to write. Default stdout. Tests pass a capturing stream. */
  destination?: DestinationStream;
}

/**
 * Level resolution: `SCOUT_LOG_LEVEL` if valid; otherwise `silent` under tests (`VITEST` set or
 * `NODE_ENV=test`); otherwise `info`.
 */
export function resolveLogLevel(env: Record<string, string | undefined> = {}): LogLevel {
  const explicit = env['SCOUT_LOG_LEVEL']?.toLowerCase();
  if (explicit !== undefined && (LEVELS as readonly string[]).includes(explicit)) {
    return explicit as LogLevel;
  }
  if (env['VITEST'] !== undefined || env['NODE_ENV'] === 'test') return 'silent';
  return 'info';
}

/** pino's standard `err` serializer with `message`/`stack` scrubbed by `redactText`. */
function redactingErrSerializer(err: Error): ReturnType<typeof pino.stdSerializers.err> {
  const out = pino.stdSerializers.err(err);
  if (typeof out.message === 'string') out.message = redactText(out.message);
  if (typeof out.stack === 'string') out.stack = redactText(out.stack);
  return out;
}

/**
 * Build a logger with credential redaction.
 *
 * @example
 * ```ts
 * const log = createLogger({ env: process.env }); // entry point only
 * log.child({ adapter: 'edgar' }).info({ accession }, 'new filing');
 * ```
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? resolveLogLevel(options.env ?? {});
  const opts: LoggerOptions = {
    name: options.name ?? 'scout',
    level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    serializers: { err: redactingErrSerializer },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? redactText(a) : a));
        method.apply(this, scrubbed as unknown as Parameters<typeof method>);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return options.destination === undefined ? pino(opts) : pino(opts, options.destination);
}

/** A logger that discards everything (tests, replay). */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'silent' });
}
