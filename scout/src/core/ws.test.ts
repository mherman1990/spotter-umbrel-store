import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressDeniedError } from './errors.js';
import { createWebSocketFactory } from './ws.js';

const servers: WebSocketServer[] = [];

async function listen(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  await new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    await new Promise<void>((resolve) => s?.close(() => resolve()));
  }
});

describe('createWebSocketFactory policy', () => {
  const factory = createWebSocketFactory({
    allowedHosts: ['streamer.example'],
    allowedWsHostSuffixes: ['.schwab.com'],
  });

  it('refuses non-allowlisted hosts and non-wss schemes before connecting', () => {
    expect(() => factory('wss://evil.example/ws')).toThrow(EgressDeniedError);
    expect(() => factory('wss://streamer.example:8443/ws')).toThrow(EgressDeniedError);
    expect(() => factory('wss://streamer-api.schwab.com:8443/ws')).toThrow(EgressDeniedError);
    expect(() => factory('ws://streamer.example/ws')).toThrow(EgressDeniedError);
    expect(() => factory('https://streamer.example/ws')).toThrow(EgressDeniedError);
    expect(() => factory('wss://evilschwab.com/ws')).toThrow(EgressDeniedError);
  });
});

describe('createWebSocketFactory over loopback (real ws adapter, no external network)', () => {
  it('delivers open, text and binary frames as UTF-8 text, accepts sends, and reports close', async () => {
    const { server, port } = await listen();
    server.on('connection', (sock, req) => {
      sock.send('hello');
      sock.send(Buffer.from('biné'), { binary: true });
      sock.on('message', (m: Buffer) => {
        sock.send(`echo:${m.toString('utf8')}:${String(req.headers['x-test'])}`);
        sock.close(1000, 'done');
      });
    });

    const factory = createWebSocketFactory({
      allowedHosts: ['127.0.0.1'],
      allowHttpHosts: ['127.0.0.1'],
      allowedPorts: { '127.0.0.1': [port] },
    });
    const ws = factory(`ws://127.0.0.1:${port}/`, { headers: { 'x-test': 'yes' } });
    const received: string[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      ws.onopen = () => ws.send('ping');
      ws.onmessage = (m) => received.push(m.data);
      ws.onclose = resolve;
      ws.onerror = (e) => reject(new Error(e.message));
    });
    const c = await closed;
    expect(received).toEqual(['hello', 'biné', 'echo:ping:yes']);
    expect(c).toEqual({ code: 1000, reason: 'done' });
    expect(ws.readyState).toBe(3);
  });

  it('reports connection errors through onerror', async () => {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve())); // port now refuses connections
    const factory = createWebSocketFactory({
      allowedHosts: ['127.0.0.1'],
      allowHttpHosts: ['127.0.0.1'],
      allowedPorts: { '127.0.0.1': [port] },
    });
    const ws = factory(`ws://127.0.0.1:${port}/`);
    const err = await new Promise<string>((resolve) => {
      ws.onerror = (e) => resolve(e.message);
    });
    expect(err).toMatch(/ECONNREFUSED|connect/i);
  });
});
