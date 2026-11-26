# Test fixtures

- Fixtures that are NOT recorded from the real service MUST be labelled SYNTHETIC (file name contains
  `synthetic`/`SYNTHETIC`, or the JSON has `"_synthetic": true`). Decision D29/D32.
- Real recordings come from `scripts/record-fixture.mjs` run by the owner on the Pi (slot B4) and live under
  `replay/<date>/`.
- Load with `loadFixture(...)` / `loadJsonFixture(...)` from `src/test-support`.
