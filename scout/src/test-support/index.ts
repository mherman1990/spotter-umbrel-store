/**
 * Test support: fakes and factories reused by every module's tests. NOT part of the production build
 * (`tsconfig.build.json` excludes this directory) and never imported by `src/` code outside tests; the policy
 * test enforces both. See docs/ARCHITECTURE.md ("Testing contract").
 */
export * from './factories.js';
export * from './fake-http.js';
export * from './fake-llm.js';
export * from './fake-ws.js';
export * from './fixtures.js';
export * from './recording-notifier.js';
export * from './temp-db.js';
