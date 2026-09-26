import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, test } from "vitest";
import { createCompactionAccounting } from "../agents/embedded-agent-runner/compact.accounting.js";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.queued-execution.js";
import { withSessionCompactionPersistence } from "../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  readSessionTranscriptActiveStats,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { embeddedRunMock } from "./test-helpers.runtime-state.js";
import { onceMessage, rpcReq } from "./test-helpers.server.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

// Evidence-only child of the product head: real loopback transport and SQLite,
// deterministic compaction backend; no provider credentials or channel sends.
const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("host commit survives native failure and reaches its subscribed WebSocket exactly once", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "proof-session",
    storePath,
  };
  await upsertSessionEntryCore(
    target,
    sessionStoreEntry(target.sessionId, {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      compactionCount: 2,
      cliSessionIds: { "codex-cli": "synthetic-native-thread" },
    }),
  );
  const manager = SessionManager.open(target, dir);
  manager.appendMessage({ role: "user", content: "Synthetic older context.", timestamp: 1 });
  const keptId = manager.appendMessage({
    role: "user",
    content: "Keep this message.",
    timestamp: 2,
  });
  const before = loadSessionEntry({ ...target, readConsistency: "latest" });
  const transcriptBefore = loadTranscriptEventsSync(target);
  const trace: Array<Record<string, unknown>> = [];
  const record = (entry: Record<string, unknown>) =>
    trace.push({ sequence: trace.length + 1, ...entry });
  record({
    kind: "persisted-before",
    sessionId: before?.sessionId,
    compactionCount: before?.compactionCount,
  });
  let backendCalls = 0;
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementation(async (_input, hostInput) => {
    backendCalls++;
    record({ kind: "synthetic-backend-enter", call: backendCalls });
    if (backendCalls === 1) {
      const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
      if (!entry) throw new Error("Missing accepted session");
      const accounting = createCompactionAccounting({
        target,
        entry,
        byteBudget: {
          activeBytes: readSessionTranscriptActiveStats(target).sizeBytes,
          maxBytes: 1,
        },
        host: {
          ...(hostInput as QueuedCompactionHostOptions),
          transcriptBytePreflightHarness: "codex",
        },
      });
      withSessionCompactionPersistence(manager, accounting.host.withCompactionPersistence, () =>
        manager.appendCompaction("Synthetic host summary.", keptId, 100),
      );
      const committedEntry = loadSessionEntry({ ...target, readConsistency: "latest" });
      if (!committedEntry) throw new Error("Missing committed session");
      await accounting.host.onHostCompactionCommitted?.({
        entry: committedEntry,
        compactionKind: "context-engine",
        tokensAfter: 20,
      });
      expect(accounting.committed).toBe(true);
      record({
        kind: "host-committed",
        sessionId: accounting.entry.sessionId,
        compactionCount: accounting.entry.compactionCount,
      });
    }
    return {
      ok: false,
      compacted: backendCalls === 1,
      compactionKind: "context-engine",
      reason: "synthetic native compaction failure",
      result: {
        summary: "",
        firstKeptEntryId: keptId,
        tokensBefore: 100,
        details: { backend: "synthetic-codex", completed: false, pending: false },
      },
    };
  });
  const { ws } = await openClient();
  const changes: Array<Record<string, unknown>> = [];
  const operations: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data));
    if (frame.type === "event" && ["sessions.changed", "session.operation"].includes(frame.event)) {
      record({ kind: "wire-receive", frame });
      if (frame.event === "sessions.changed" && frame.payload.reason === "compact")
        changes.push(frame.payload);
      if (frame.event === "session.operation") operations.push(frame.payload);
    }
  });
  let requestSequence = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const frame = { type: "req", id: `proof-${++requestSequence}`, method, params };
    const response = onceMessage(
      ws,
      (candidate) => candidate.type === "res" && candidate.id === frame.id,
    );
    record({ kind: "wire-send", frame });
    ws.send(JSON.stringify(frame));
    const received = await response;
    record({ kind: "wire-response", frame: received });
    return received;
  };
  const subscribed = await rpcReq(ws, "sessions.subscribe", {});
  expect(subscribed).toMatchObject({ ok: true, payload: { subscribed: true } });
  record({ kind: "wire-response", frame: subscribed });
  const changed = onceMessage(
    ws,
    (frame) =>
      frame.type === "event" &&
      frame.event === "sessions.changed" &&
      frame.payload?.reason === "compact",
  );
  const response = await request("sessions.compact", { key: "main" });
  expect(response).toMatchObject({
    ok: true,
    payload: {
      ok: false,
      compacted: true,
      key: target.sessionKey,
      reason: "synthetic native compaction failure",
    },
  });
  await changed;
  // Drain the real publisher, then a response on the same ordered socket proves
  // every previously sent notice has crossed the transport before counting it.
  await flushPendingSessionsChangedEvents();
  const barrier = await request("sessions.list", {});
  expect(barrier.ok).toBe(true);
  record({ kind: "wire-barrier", id: barrier.id, ok: barrier.ok });
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    compacted: true,
    session: { sessionId: target.sessionId },
  });
  expect(operations.filter((event) => event.phase === "end")).toEqual([
    expect.objectContaining({ completed: false, reason: "synthetic native compaction failure" }),
  ]);
  const after = loadSessionEntry({ ...target, readConsistency: "latest" });
  const transcriptAfter = loadTranscriptEventsSync(target);
  expect(after).toMatchObject({ sessionId: target.sessionId, compactionCount: 3, totalTokens: 20 });
  expect(transcriptAfter).toHaveLength(transcriptBefore.length + 1);
  expect(transcriptAfter.at(-1)).toMatchObject({
    type: "compaction",
    summary: "Synthetic host summary.",
  });
  record({
    kind: "persisted-after",
    sessionId: after?.sessionId,
    compactionCount: after?.compactionCount,
    transcriptEvents: transcriptAfter.length,
    boundary: transcriptAfter.at(-1),
  });
  const failedWithoutCommit = await request("sessions.compact", { key: "main" });
  expect(failedWithoutCommit).toMatchObject({ ok: true, payload: { ok: false, compacted: false } });
  await flushPendingSessionsChangedEvents();
  const finalBarrier = await request("sessions.list", {});
  expect(finalBarrier.ok).toBe(true);
  record({ kind: "wire-barrier", id: finalBarrier.id, ok: finalBarrier.ok });
  expect(changes).toHaveLength(1);
  expect(backendCalls).toBe(2);
  expect(loadSessionEntry({ ...target, readConsistency: "latest" })?.compactionCount).toBe(3);
  expect(loadTranscriptEventsSync(target)).toEqual(transcriptAfter);
  record({
    kind: "verdict",
    status: "pass",
    backendCalls,
    compactNotices: changes.length,
    compactionCount: 3,
    noCommitFailurePreservedState: true,
  });
  ws.close();
  const artifactDir = process.env.OPENCLAW_PR158044_PROOF_DIR;
  if (!artifactDir)
    throw new Error("OPENCLAW_PR158044_PROOF_DIR is required for this evidence-only test");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(
    path.join(artifactDir, "transport-trace.json"),
    JSON.stringify(
      {
        productHead: "51b023f174369b5ee953ad59e20dd65dfe736649",
        boundaries: {
          gateway: "real ephemeral loopback WebSocket",
          persistence: "real SQLite and compaction accounting",
          backend: "synthetic host summary and native failure; no live Codex or channel",
        },
        trace,
      },
      null,
      2,
    ) + "\n",
  );
});
