import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../store/db.js';
import { migrate } from '../store/migrate.js';
import { Store } from '../store/index.js';

export interface TempStore {
  store: Store;
  /** The database file path (`:memory:` for in-memory). */
  file: string;
  /** Close the DB and remove the temp directory. Idempotent. */
  close(): void;
}

/** A fresh in-memory migrated store. Call `close()` in `afterEach` (cheap; avoids handle leaks). */
export function tempDb(): TempStore {
  const db = openDb(':memory:');
  migrate(db);
  const store = new Store(db);
  return {
    store,
    file: ':memory:',
    close: () => {
      if (db.open) db.close();
    },
  };
}

/**
 * A migrated store backed by a real file in a temp directory (WAL, `-wal`/`-shm` files exist), for tests that
 * need file semantics (backups, two connections, scanning the files on disk).
 */
export function tempDbFile(): TempStore & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-test-'));
  const file = path.join(dir, 'scout.db');
  const db = openDb(file);
  migrate(db);
  const store = new Store(db);
  return {
    store,
    file,
    dir,
    close: () => {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A temp directory removed by `cleanup()`. */
export function tempDir(prefix = 'scout-tmp-'): { dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
