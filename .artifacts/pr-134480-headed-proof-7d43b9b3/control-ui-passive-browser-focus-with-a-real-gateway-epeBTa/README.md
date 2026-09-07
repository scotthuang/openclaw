# PR #134480 exact-head headed-browser proof

## Locked commits

- Frozen product base: `c27999bcfc3721befd3bd5e5ae2982ddd464b743`
- Product head: `969162dfdf4601b25429c56b7759d5b0b65227b2`
- Executable evidence head: `7d43b9b307c6905c8f4492feee44913e64dd6377`
- The evidence head's sole parent is the product head.

## Environment and boundary

The passing run used an isolated real Gateway, the prebuilt Control UI from the
exact evidence head, the real Browser plugin, and a separately launched headed
Chromium with a temporary profile. OpenClaw attached to it as profile `user`
with `attachOnly: true` and `headless: false`.

The earlier agent-to-transcript delivery was seeded synthetically so the card
could be rendered deterministically. Gateway routing, Control UI behavior,
Browser-plugin requests, screenshot/evaluate calls, explicit focus, and fresh
browser-level CDP observations were real.

Renderer visibility is not the activation oracle because Playwright enables
focus emulation on attached pages. The proof instead reads Chrome's tab-strip
metadata through a fresh `Target.getTargets` call at every stage and verifies
that both proof tabs share the same browser context and Chrome window. Chromium
added `embedderData.tabActive` specifically for this purpose:
https://chromium.googlesource.com/chromium/src/+/5aa804ae0b62bd1b0d54f57494211239e2ed5ffe

## Result

The exact-head run passed 1/1.

- Direct `/screenshot` preserved the sentinel active tab.
- Direct `/act` `evaluate` preserved the sentinel active tab and returned the canary.
- Initial card thumbnail capture preserved the sentinel active tab.
- Passive Browser-panel follow issued `/tabs`, `/screenshot`, and `/act` evaluate,
  issued zero `/tabs/focus` requests, and preserved the sentinel active tab.
- Clicking the card's Open button issued exactly one `/tabs/focus`; the target
  then became the active tab and the browser process remained alive.

The identical proof source applied to the frozen pre-fix product base failed
1/1 at `ui/src/e2e/browser-passive-focus.pr-134480.proof.ts:553`: passive panel
follow issued one `/tabs/focus` request when zero was expected.

## Artifact checksums

```text
1591c066d412398ff0e8bc44b67f041ef1cffac68c596011d07ff2168e32cbea  01-card-passive.png
c74041210b8f9d3b61e020ebca2b1a3acd2d66f7deb3ced04237f9fd80398f70  02-panel-passive.png
9340ffa318b78dad9f84e1642f12c2df51d1f60f2eb243078c3b65237d42555c  03-explicit-open.png
6e503a6f30976ef328fe80f59cf4704ea3d476b00708e96d66599860be1fe6f8  page@3a4464a6758cf2465bfd78aae8556931.webm
ff94864d2e59aac3b1f126e4217d4bb4a9fa719e1c6979d94fa7a5d0b9f3d673  verdict.json
```
