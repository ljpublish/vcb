# Tests

| What | Command | Where |
|---|---|---|
| Unit tests (pure TS, Node) | `npm run test:unit` | `tests/unit/*.test.ts` (Vitest) |
| Browser play-tests | `npm run test:e2e` | `tests/e2e/*.spec.ts` (Playwright, headless Chromium + SwiftShader) |
| Type-check the tests | `npm run typecheck:tests` | `tests/tsconfig.json` |

CI (`.github/workflows/ci.yml`) runs all of them on every PR and on pushes to `main`. Screenshots
(`test-results/screenshots/*.png`) and the HTML report are uploaded as the `playtest-<run>` artifact.

## Pending tests

Tests that need a module which is still a skeleton stub skip themselves with a `pending: …` reason.
A module counts as merged once the header comment of its entry file (see `MODULE_ENTRY` in
`tests/support/pending.ts`) no longer contains the word `STUB`. So when you replace a stub, delete
the `STUB:` line from the header and that module's tests switch on.

Run pending tests anyway with `VCB_TEST_ALL=1 npm run test:unit` (or `test:e2e`).

## Play-tests

`npm run test:e2e` builds the game into `.e2e-dist/` and serves it with `vite preview`. To test a
running dev server instead: `VCB_E2E_URL=http://127.0.0.1:5199 npm run test:e2e`.

The `game` fixture (`tests/e2e/fixtures.ts`) opens `/?seed=12345`, waits until the game is idle
(not busy, meshes idle, structures flushed) and fails the test on any console error or uncaught
exception. Drive the game through `window.__vcb` (the `Game`, see ARCHITECTURE.md §1).
