/**
 * Fixture loader. Fixtures live under `<repo>/test/fixtures/`. Fixtures NOT recorded from the real service
 * MUST be labelled SYNTHETIC (file name or a `_synthetic` field) - decision D29/D32.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures',
);

/** Absolute path of a fixture (`edgar/submissions.synthetic.json`). */
export function fixturePath(...parts: string[]): string {
  return path.join(FIXTURES_DIR, ...parts);
}

/** Fixture as UTF-8 text. @throws if missing (a missing fixture is a test bug, not a skip). */
export function loadFixture(...parts: string[]): string {
  return fs.readFileSync(fixturePath(...parts), 'utf8');
}

/** Fixture parsed as JSON. */
export function loadJsonFixture<T = unknown>(...parts: string[]): T {
  return JSON.parse(loadFixture(...parts)) as T;
}

/** Fixture as raw bytes (binary or encoding-sensitive payloads). */
export function loadFixtureBytes(...parts: string[]): Uint8Array {
  return new Uint8Array(fs.readFileSync(fixturePath(...parts)));
}

/** True when the fixture exists (for optional replay data). */
export function hasFixture(...parts: string[]): boolean {
  return fs.existsSync(fixturePath(...parts));
}
