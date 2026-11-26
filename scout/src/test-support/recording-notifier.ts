import type { AlertMessage, Notifier, SendResult } from '../notify/types.js';

/**
 * Notifier that records everything it is asked to send. Script failures with `failNext(...)`.
 *
 * @example
 * ```ts
 * const n = new RecordingNotifier('openclaw');
 * n.failNext({ ok: false, status: 'failed', detail: 'ECONNREFUSED', channel: 'openclaw', retryable: true });
 * ```
 */
export class RecordingNotifier implements Notifier {
  readonly sent: AlertMessage[] = [];
  private readonly scripted: SendResult[] = [];

  constructor(readonly id = 'recording') {}

  /** Queue a result for the next `send` (FIFO). After the queue is empty, sends succeed. */
  failNext(result: Partial<SendResult> = {}): this {
    this.scripted.push({
      ok: false,
      status: 'failed',
      detail: 'scripted failure',
      channel: this.id,
      retryable: true,
      ...result,
    });
    return this;
  }

  send(message: AlertMessage): Promise<SendResult> {
    this.sent.push(message);
    const scripted = this.scripted.shift();
    if (scripted !== undefined) return Promise.resolve(scripted);
    return Promise.resolve({
      ok: true,
      status: 'sent',
      detail: 'recorded',
      channel: this.id,
      retryable: false,
    });
  }

  /** Messages for one idempotency key (assert exactly-once delivery). */
  withKey(idempotencyKey: string): AlertMessage[] {
    return this.sent.filter((m) => m.idempotencyKey === idempotencyKey);
  }
}
