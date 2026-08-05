# PR #116382 exact-head Control UI proof

- PR head: `9d8da6ec433cfe99857733fbba9b8d32409127ab`
- Base used for the rebase: `72fd25d47d1d5ae772de8af052623cc869bf2af0`
- Browser: Google Chrome via Playwright, 1280 x 900
- Gateway: repository Control UI E2E mocked-Gateway harness
- Result: 1 test passed in 125.99 seconds

## Scenarios

1. A same-session background append advanced the active path while the UI history refresh was still pending. The submit kept the rendered `{ sessionId, expectedLeafEntryId }` pair and the send completed visibly.
2. A disconnected send was persisted in `sessionStorage`, the canonical transcript rotated to a new session and leaf, and the page was hard-reloaded. Reconnect replay kept the old revision pair; Gateway's typed `active-leaf-changed` rejection parked the row as `Failed` with `The thread switched branches — review and resend.`

The browser proof covers the current Control UI persistence and presentation behavior. Focused exact-head Gateway/SQLite tests independently cover server-side active-path acceptance and generation rejection.

## Command

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
OPENCLAW_PR_116382_HEAD=9d8da6ec433cfe99857733fbba9b8d32409127ab \
OPENCLAW_PR_116382_PROOF_DIR=.artifacts/control-ui-e2e/pr-116382-exact-head \
node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.ui-e2e.config.ts \
  --configLoader runner \
  ui/src/e2e/pr-116382-exact-head-proof.e2e.test.ts
```

## SHA-256

```text
f923dd0107734a5c4dbe3890e66db4f9b74a500a4f58d9cc0cbd46d23f27f356  01-same-branch-send-accepted.png
3fb70a32f429ad27d0154f14f3d573c110a8f1c9e9701fa78165592e83d47a00  01-same-branch-send-accepted.webm
7fe69cae9d35ee894bcb4b857c857b6f5a40378c565101cc70ac359837f7db52  02-queued-before-branch-switch.png
fa94d3f9f69e1fd9de6a293b25032debceb1a62f3c97781086999d54734db065  02-restored-cross-branch-needs-review.webm
402af54f3d4847bd477672cc50bd313494679c909be92f2e15235dbae7f3be92  03-restored-cross-branch-needs-review.png
c9cc174117a858ffaae377d2ec52f57891014e2c0eb39a0d3376555492e1550f  pr-116382-exact-head-proof.json
```
