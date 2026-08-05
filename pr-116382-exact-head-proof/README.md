# PR #116382 exact-head Control UI proof

- PR head: `fd7127dabf10dcb06fa8603ae8609febd30531cd`
- Rebased base: `7321c4424683ee5831f1d5602c403f0c66f51259`
- Browser: Google Chrome via Playwright, 1280 x 900
- Gateway: repository Control UI E2E mocked-Gateway harness
- Published harness: `ui/src/e2e/pr-116382-exact-head-proof.e2e.test.ts` on this evidence-only branch
- Result: 1 file passed, 2/2 browser scenarios passed in 138.69 seconds
- Focused owner-boundary validation: 606 passed (Gateway 262, SQLite/session 11, Control UI/outbox 333)
- Runner note: trusted local fallback; Crabbox/Testbox executables were unavailable on the operator host

## Scenarios

1. A same-session background append advanced the active path while the UI history refresh was still pending. The submit kept the rendered `{ sessionId, expectedLeafEntryId }` pair and the send completed visibly.
2. A disconnected send was persisted in `sessionStorage`, the canonical transcript rotated to a new session and leaf, and the page was hard-reloaded. Reconnect replay kept the old revision pair; Gateway's typed `active-leaf-changed` rejection parked the row as `Failed` with `The thread switched branches — review and resend.`

The browser proof covers the current Control UI persistence and presentation behavior. Focused exact-head Gateway/SQLite tests independently cover server-side active-path acceptance and generation rejection.

The first harness invocation placed both recorded browser contexts in one test and reached the second scenario before hitting the unchanged 120-second per-test budget. The final harness splits the independent scenarios into two tests; no timeout was increased. Both passed.

## Command

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
OPENCLAW_PR_116382_HEAD=fd7127dabf10dcb06fa8603ae8609febd30531cd \
OPENCLAW_PR_116382_PROOF_DIR=.artifacts/control-ui-e2e/pr-116382-fd7127d-pass \
node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.ui-e2e.config.ts \
  --configLoader runner \
  ui/src/e2e/pr-116382-exact-head-proof.e2e.test.ts
```

Focused tests:

```sh
node scripts/run-vitest.mjs \
  src/config/sessions/session-accessor.sqlite-active-events.test.ts \
  src/gateway/server-methods/chat.directive-tags.test.ts \
  src/gateway/server.chat.gateway-server-chat-b.test.ts \
  ui/src/lib/chat/outbox-store.test.ts \
  ui/src/pages/chat/chat-send.test.ts \
  ui/src/pages/chat/composer-persistence.test.ts
```

## Video integrity

Local `ffprobe` successfully read both WebM containers:

- `01-same-branch-send-accepted.webm`: 59.76 seconds, 812666 bytes
- `02-restored-cross-branch-needs-review.webm`: 69.96 seconds, 1054911 bytes

## Codex steering contract

Direct sibling-source review used clean Codex commit `e98d43ac372ddf7f513c0e30c56dd8dc35ea5404`:

- `codex-rs/app-server-protocol/src/protocol/v2/turn.rs:174`: `TurnSteerParams` requires `expected_turn_id` and documents active-turn mismatch failure.
- `codex-rs/app-server/src/request_processors/turn_processor.rs:811`: app-server rejects an empty value and forwards the precondition to core.
- `codex-rs/core/src/session/mod.rs:3705`: core locks the active turn and rejects a mismatched expected turn ID before steering.
- OpenClaw passes the run's exact turn ID as `expectedTurnId` in `extensions/codex/src/app-server/attempt-steering.ts:144`.

## SHA-256

```text
f923dd0107734a5c4dbe3890e66db4f9b74a500a4f58d9cc0cbd46d23f27f356  01-same-branch-send-accepted.png
b3bd1568d85543ca588e6a8675726d36120ca6f552a0b8bc698f1fb4db4044cc  01-same-branch-send-accepted.webm
2f64629c45e550b95df603f4f2839c5c8a9c91dd782ff8652b9430c6d05171cf  02-queued-before-branch-switch.png
0539084fa0a434e9e6d6bef2b74d147795c7e8271bd60e9af1cfb0346441011d  02-restored-cross-branch-needs-review.webm
402af54f3d4847bd477672cc50bd313494679c909be92f2e15235dbae7f3be92  03-restored-cross-branch-needs-review.png
4114ebe6478f3b26c2fead1d71a658c8831148a51e31ab91a53068cf68812c92  pr-116382-exact-head-proof.json
d737a6ad9916123582208daa1ad9c4508b1617f397c2b661ed97188fd1104f1b  ui/src/e2e/pr-116382-exact-head-proof.e2e.test.ts
```
