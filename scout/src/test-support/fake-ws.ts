/**
 * Fake WebSocket + factory for streaming tests (Schwab streamer). The test drives the "server" side:
 * `open()`, `receive(obj)`, `serverClose()`, `fail()`; the code under test drives `send`/`close`.
 */
import type { WebSocketFactory, WebSocketLike, WebSocketOptions } from '../core/ws.js';

export interface FakeWebSocketBehavior {
  /**
   * Real `ws` closes ASYNCHRONOUSLY: `close()` moves to CLOSING (2) and `onclose` fires later. With
   * `asyncClose: true` the fake does the same (on a microtask), which exposes reconnect-reentrancy bugs that a
   * synchronous `onclose` hides. Default false (legacy synchronous behavior).
   */
  asyncClose?: boolean;
  /**
   * Real `ws` THROWS on `send` only while CONNECTING and silently drops it after CLOSING/CLOSED. With
   * `strictSend: false` the fake behaves that way; default true throws whenever the socket is not OPEN (the
   * stricter, test-friendly legacy behavior).
   */
  strictSend?: boolean;
}

export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly options?: WebSocketOptions,
    private readonly behavior: FakeWebSocketBehavior = {},
  ) {}

  send(data: string): void {
    if (this.readyState === 1) {
      this.sent.push(data);
      return;
    }
    if (this.behavior.strictSend === false && this.readyState !== 0) return; // CLOSING/CLOSED: dropped, like ws
    throw new Error('FakeWebSocket: send while not OPEN');
  }

  /** Client-initiated close (fires `onclose` like a real socket after the handshake; async with `asyncClose`). */
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3 || this.readyState === 2) return;
    if (this.behavior.asyncClose === true) {
      this.readyState = 2;
      queueMicrotask(() => {
        this.readyState = 3;
        this.closedWith = { code, reason };
        this.onclose?.({ code, reason });
      });
      return;
    }
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }

  // ---- test controls ----

  /** Server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Server sends a frame (objects are JSON-stringified). */
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  /** Server drops the connection. */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }

  /** Transport error event. */
  fail(message = 'socket error'): void {
    this.onerror?.({ message });
  }

  /** Parsed JSON of every frame sent so far (non-JSON frames are skipped). */
  sentJson(): unknown[] {
    const out: unknown[] = [];
    for (const s of this.sent) {
      try {
        out.push(JSON.parse(s));
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

/** Factory recording every socket it creates. `factory` is a `WebSocketFactory` to inject. */
export class FakeWebSocketFactory {
  readonly sockets: FakeWebSocket[] = [];
  /** When set, the NEXT `factory(...)` call throws it (simulates an egress denial or DNS failure). */
  failNextWith: Error | null = null;
  /** Open sockets automatically on creation (default false: tests call `open()` to control timing). */
  autoOpen = false;
  /** Behavior flags handed to every socket created after they are set (see {@link FakeWebSocketBehavior}). */
  behavior: FakeWebSocketBehavior = {};

  readonly factory: WebSocketFactory = (url, options) => {
    if (this.failNextWith !== null) {
      const e = this.failNextWith;
      this.failNextWith = null;
      throw e;
    }
    const ws = new FakeWebSocket(url, options, this.behavior);
    this.sockets.push(ws);
    if (this.autoOpen) queueMicrotask(() => ws.open());
    return ws;
  };

  /** The most recently created socket. */
  latest(): FakeWebSocket {
    const s = this.sockets.at(-1);
    if (s === undefined) throw new Error('FakeWebSocketFactory: no socket created yet');
    return s;
  }
}
