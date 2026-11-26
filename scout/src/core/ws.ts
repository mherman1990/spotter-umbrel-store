/**
 * WebSocket seam. The only module that imports the `ws` package (policy test). Streaming code (Schwab
 * streamer) depends on {@link WebSocketLike}/{@link WebSocketFactory}; tests inject `FakeWebSocketFactory`
 * from `src/test-support`. The factory enforces the egress policy (host allowlist + wss-only, with the
 * dynamic-host suffix rule for the Schwab streamer, decision D13).
 */
import { WebSocket as WsWebSocket } from 'ws';
import { EgressPolicy, type EgressPolicyOptions } from './egress.js';

/** Browser-like subset of WebSocket that Scout needs. `readyState`: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
}

export interface WebSocketOptions {
  /** Extra upgrade headers. */
  headers?: Record<string, string>;
}

export type WebSocketFactory = (url: string, options?: WebSocketOptions) => WebSocketLike;

export const WS_OPEN = 1;

/**
 * Production factory over `ws`. Throws EgressDeniedError for a non-allowlisted host or a non-wss scheme before
 * any connection is attempted. Binary frames are decoded as UTF-8 text.
 */
export function createWebSocketFactory(policyOptions: EgressPolicyOptions): WebSocketFactory {
  const policy = new EgressPolicy(policyOptions);
  return (url, options) => {
    policy.assert(url, 'ws');
    const ws = new WsWebSocket(url, { headers: options?.headers ?? {}, handshakeTimeout: 15_000 });
    const like: WebSocketLike = {
      get readyState() {
        return ws.readyState;
      },
      send: (data) => {
        ws.send(data);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.on('open', () => like.onopen?.());
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
      like.onmessage?.({ data: text });
    });
    ws.on('close', (code: number, reason: Buffer) =>
      like.onclose?.({ code, reason: reason.toString('utf8') }),
    );
    ws.on('error', (err: Error) => like.onerror?.({ message: err.message }));
    return like;
  };
}
