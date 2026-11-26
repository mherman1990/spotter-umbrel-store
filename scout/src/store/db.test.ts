import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, tempDbFile } from '../test-support/temp-db.js';
import {
  backupDb,
  checkpointWal,
  closeDb,
  integrityCheck,
  openDb,
  pruneBackups,
  readTransaction,
  writeTransaction,
} from './db.js';
import { migrate } from './migrate.js';
import { Store } from './index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('openDb pragmas (Spotter settings)', () => {
  it('file DB: WAL, synchronous FULL, foreign keys ON, busy_timeout 5000, cache -16000, temp memory', () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    const db = t.store.db;
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL: committed means durable
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('cache_size', { simple: true })).toBe(-16000);
    expect(db.pragma('temp_store', { simple: true })).toBe(2);
  });

  it('creates parent directories and supports :memory:', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = path.join(t.dir, 'a', 'b', 'scout.db');
    const db = openDb(file);
    expect(fs.existsSync(file)).toBe(true);
    db.close();
    const mem = openDb(':memory:');
    expect(mem.open).toBe(true);
    mem.close();
  });

  it('readonly open refuses writes and needs an existing file', () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    const ro = openDb(t.file, { readonly: true });
    expect(() => ro.exec('CREATE TABLE x (a)')).toThrow();
    ro.close();
    expect(() => openDb(path.join(t.dir, 'missing.db'), { readonly: true })).toThrow();
  });
});

describe('transactions', () => {
  it('readTransaction gives one consistent snapshot while another connection commits', () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    const writer = openDb(t.file);
    const reader = openDb(t.file);
    writer.exec("INSERT INTO kv_state (key, value_json, updated_at) VALUES ('a', '1', 'x')");
    const seen = readTransaction(reader, () => {
      const first = reader.prepare('SELECT COUNT(*) AS n FROM kv_state').get() as { n: number };
      writer.exec("INSERT INTO kv_state (key, value_json, updated_at) VALUES ('b', '2', 'x')"); // commits mid-read
      const second = reader.prepare('SELECT COUNT(*) AS n FROM kv_state').get() as { n: number };
      return [first.n, second.n];
    });
    expect(seen).toEqual([1, 1]);
    expect((reader.prepare('SELECT COUNT(*) AS n FROM kv_state').get() as { n: number }).n).toBe(2);
    writer.close();
    reader.close();
  });

  it('writeTransaction is atomic: a throw rolls everything back', () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    const db = t.store.db;
    expect(() =>
      writeTransaction(db, () => {
        db.exec("INSERT INTO kv_state (key, value_json, updated_at) VALUES ('a', '1', 'x')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect((db.prepare('SELECT COUNT(*) AS n FROM kv_state').get() as { n: number }).n).toBe(0);
  });

  it('Store.transaction joins an enclosing transaction instead of failing', () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    const store = t.store;
    store.transaction(() => {
      store.kv.set('a', 1, new Date(0));
      store.transaction(() => store.kv.set('b', 2, new Date(0)));
    });
    expect(store.kv.get('b')).toBe(2);
    expect(() =>
      store.transaction(() => {
        store.kv.set('c', 3, new Date(0));
        store.transaction(() => {
          throw new Error('inner');
        });
      }),
    ).toThrow('inner');
    expect(store.kv.get('c')).toBeUndefined();
  });
});

describe('integrity, checkpoint, close', () => {
  it('integrityCheck reports ok on a healthy DB; checkpoint and close are safe', () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    expect(integrityCheck(t.store.db)).toEqual({ ok: true, messages: ['ok'] });
    expect(integrityCheck(t.store.db, true).ok).toBe(true);
    t.store.kv.set('k', 1, new Date(0));
    checkpointWal(t.store.db);
    closeDb(t.store.db);
    expect(t.store.db.open).toBe(false);
    closeDb(t.store.db); // second call is a no-op
  });
});

describe('online backup', () => {
  it('copies a consistent database, verifies it, leaves no .partial file, and the copy is usable', async () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    t.store.kv.set('hello', { n: 1 }, new Date(0));
    const dest = path.join(t.dir, 'backups', 'scout-2026-12-03T0300.db');
    const res = await backupDb(t.store.db, dest);
    expect(res.path).toBe(dest);
    expect(res.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(`${dest}.partial`)).toBe(false);
    const copy = openDb(dest, { readonly: true });
    expect(
      (
        copy.prepare("SELECT value_json FROM kv_state WHERE key = 'hello'").get() as {
          value_json: string;
        }
      ).value_json,
    ).toBe('{"n":1}');
    copy.close();
  });

  it('token_state has no plaintext token column: only the encrypted blob and non-secret metadata', async () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    const cols = (t.store.db.prepare('PRAGMA table_info(token_state)').all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        'access_expires_at',
        'encrypted_blob',
        'id',
        'last_error',
        'last_refresh_ok_at',
        'quotes_down_alerted_at',
        'refresh_token_issued_at',
        'sent_24h',
        'sent_6h',
        'sent_expired',
        'updated_at',
      ].sort(),
    );
    t.store.tokenState.saveTokens(
      'schwab',
      Buffer.from('CIPHERTEXT-ONLY'),
      new Date(1000),
      new Date(0),
      { newRefreshToken: true },
    );
    const dest = path.join(t.dir, 'b.db');
    await backupDb(t.store.db, dest);
    expect(fs.readFileSync(dest).includes(Buffer.from('CIPHERTEXT-ONLY'))).toBe(true); // stored verbatim; encryption is the caller's job
  });

  it('pruneBackups keeps the newest N matching files and ignores others', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    for (const n of [
      'scout-2026-12-01.db',
      'scout-2026-12-02.db',
      'scout-2026-12-03.db',
      'other.db',
      'scout-2026-12-04.txt',
    ]) {
      fs.writeFileSync(path.join(t.dir, n), 'x');
    }
    const removed = pruneBackups(t.dir, 2);
    expect(removed.map((p) => path.basename(p))).toEqual(['scout-2026-12-01.db']);
    expect(fs.readdirSync(t.dir).sort()).toEqual([
      'other.db',
      'scout-2026-12-02.db',
      'scout-2026-12-03.db',
      'scout-2026-12-04.txt',
    ]);
    expect(pruneBackups(path.join(t.dir, 'nope'), 2)).toEqual([]);
  });
});

describe('two connections to one file coexist (service + CLI)', () => {
  it('migrate() on a second handle is a no-op and both see the same data', () => {
    const t = tempDbFile();
    cleanups.push(t.close);
    const other = openDb(t.file);
    expect(migrate(other).applied).toEqual([]);
    const s2 = new Store(other);
    t.store.kv.set('shared', 1, new Date(0));
    expect(s2.kv.get('shared')).toBe(1);
    other.close();
  });
});
