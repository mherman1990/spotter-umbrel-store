/**
 * Fake LLM provider implementing `FakeLlmProviderContract` (src/llm/types.ts). Tests ONLY: production code
 * must never import this file and no env flag can swap it in (decision D20).
 */
import type {
  FakeLlmProviderContract,
  FakeLlmReply,
  ProviderBatchItem,
  ProviderBatchStatus,
  ProviderRequest,
  ProviderResult,
  TokenUsage,
} from '../llm/types.js';

const DEFAULT_USAGE: TokenUsage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

export class FakeLlmProvider implements FakeLlmProviderContract {
  readonly name = 'fake';
  readonly requests: ProviderRequest[] = [];
  private queue: FakeLlmReply[] = [];
  private batches = new Map<string, ProviderBatchStatus>();
  private batchSeq = 0;
  /** When true, `getBatch` reports `in_progress` (simulates a batch that is not back yet). */
  holdBatches = false;

  push(...replies: FakeLlmReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  reset(): void {
    this.queue = [];
    this.requests.length = 0;
    this.batches.clear();
    this.holdBatches = false;
  }

  /** How many scripted replies remain (assert 0 at the end of a test to catch unconsumed scripts). */
  remaining(): number {
    return this.queue.length;
  }

  private next(request: ProviderRequest): FakeLlmReply {
    const reply = this.queue.shift();
    if (reply === undefined)
      throw new Error('FakeLlmProvider: no scripted reply left (script every expected call)');
    return typeof reply === 'function' ? reply(request) : reply;
  }

  private build(request: ProviderRequest, reply: FakeLlmReply): ProviderResult {
    if (typeof reply === 'function') return this.build(request, reply(request));
    if ('error' in reply) throw reply.error;
    const base = {
      model: request.model,
      requestId: `req_fake_${this.requests.length}`,
      latencyMs: 5,
      fallbackUsed: false,
    };
    if ('refusal' in reply)
      return { ...base, text: '', usage: { ...DEFAULT_USAGE, output: 0 }, stopReason: 'refusal' };
    if ('maxTokens' in reply) {
      return {
        ...base,
        text: '{"material":',
        usage: { ...DEFAULT_USAGE, output: request.maxTokens },
        stopReason: 'max_tokens',
      };
    }
    const usage = { ...DEFAULT_USAGE, ...reply.usage };
    const text = 'json' in reply ? JSON.stringify(reply.json) : reply.text;
    return { ...base, model: reply.model ?? request.model, text, usage, stopReason: 'end_turn' };
  }

  complete(request: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(request);
    try {
      return Promise.resolve(this.build(request, this.next(request)));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  submitBatch(items: readonly ProviderBatchItem[]): Promise<{ batchId: string }> {
    const batchId = `batch_fake_${++this.batchSeq}`;
    const results: NonNullable<ProviderBatchStatus['results']> = [];
    for (const it of items) {
      this.requests.push(it.request);
      try {
        results.push({
          customId: it.customId,
          result: this.build(it.request, this.next(it.request)),
        });
      } catch (e) {
        results.push({ customId: it.customId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.batches.set(batchId, { batchId, status: 'ended', results });
    return Promise.resolve({ batchId });
  }

  getBatch(batchId: string): Promise<ProviderBatchStatus> {
    const b = this.batches.get(batchId);
    if (b === undefined)
      return Promise.reject(new Error(`FakeLlmProvider: unknown batch ${batchId}`));
    return Promise.resolve(this.holdBatches ? { batchId, status: 'in_progress' } : b);
  }
}
