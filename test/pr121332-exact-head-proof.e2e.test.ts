// Evidence-only log proof for PR #121332. No browser, video, or external provider.
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, it } from "vitest";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../src/agents/harness/transcript-visibility.js";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../src/agents/test-helpers/assistant-message-fixtures.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../src/config/sessions/session-accessor.js";
import { readSessionTranscriptActivePathEntryRelation } from "../src/config/sessions/session-accessor.sqlite-active-path.js";
import { waitForSessionTranscriptIndexReconcile } from "../src/config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { GatewayClientRequestError, type GatewayClient } from "../src/gateway/client.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const SESSION_KEY = "agent:main:pr121332-exact-head";
const MODEL_REF = "pr121332-proof/pr121332-proof";
const ARTIFACT_DIR = path.resolve(
  process.env.OPENCLAW_PR_121332_PROOF_DIR ??
    path.join(process.cwd(), ".artifacts", "pr121332-exact-head-proof"),
);

type Trace = { sequence: number; kind: string; operationId?: string; [key: string]: unknown };
type History = {
  sessionId?: string;
  messages?: unknown[];
  sessionInfo?: { activeLeafEntryId?: string | null };
};
type Scenario = {
  id: string;
  outcome: "accepted" | "rejected";
  observed: Record<string, unknown>;
  assertions: string[];
};
type StateSnapshot = {
  durableDigest: string;
  sessionId: string;
  activeLeafEntryId: string;
  entrySha256: string;
  transcriptSha256: string;
  visibleMessagesSha256: string;
  transcriptEventCount: number;
  visibleMessageCount: number;
  providerCount: number;
};
type Provider = {
  baseUrl: string;
  requests: Array<{ index: number; phase: string; bodySha256: string }>;
  phase: (value: string) => void;
  close: () => Promise<void>;
};

function assertProof(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fullSha(name: string): string {
  const value = process.env[name];
  assertProof(value && /^[0-9a-f]{40}$/u.test(value), `${name} must be a full SHA`);
  return value;
}

function addTrace(trace: Trace[], value: Omit<Trace, "sequence">): void {
  trace.push({ sequence: trace.length + 1, ...value });
}

function ownerOperation(
  trace: Trace[],
  scenario: string,
  operation: string,
  observed: Record<string, unknown>,
): void {
  addTrace(trace, {
    kind: "transcript.owner.operation",
    scenario,
    owner: "SessionManager",
    operation,
    ...observed,
  });
}

async function rpc<T>(params: {
  client: GatewayClient;
  trace: Trace[];
  operationId: string;
  scenario: string;
  method: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  const { client, trace, operationId, scenario, method, request } = params;
  addTrace(trace, {
    kind: "rpc.request",
    operationId,
    scenario,
    method,
    transport: "authenticated-native-websocket-rpc",
    request: {
      fields: Object.keys(request).toSorted(),
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      sessionId: request.sessionId,
      expectedLeafEntryId: request.expectedLeafEntryId,
      leafEntryId: request.leafEntryId,
    },
  });
  try {
    const result = await client.request<T>(method, request, {
      timeoutMs: params.timeoutMs ?? 30_000,
    });
    const row = isRecord(result) ? result : {};
    const info = isRecord(row.sessionInfo) ? row.sessionInfo : {};
    addTrace(trace, {
      kind: "rpc.response",
      operationId,
      scenario,
      method,
      ok: true,
      runId: row.runId,
      status: row.status,
      sessionId: row.sessionId,
      activeLeafEntryId: info.activeLeafEntryId,
      messageCount: Array.isArray(row.messages) ? row.messages.length : undefined,
      branchCount: Array.isArray(row.branches) ? row.branches.length : undefined,
    });
    return result;
  } catch (error) {
    const typed = error instanceof GatewayClientRequestError ? error : undefined;
    addTrace(trace, {
      kind: "rpc.response",
      operationId,
      scenario,
      method,
      ok: false,
      errorCode: typed?.gatewayCode ?? "unexpected-error",
      errorReason: isRecord(typed?.details) ? typed.details.reason : undefined,
    });
    throw error;
  }
}

async function expectLeafRejection(
  params: Parameters<typeof rpc>[0],
): Promise<{ code: string; reason: string }> {
  try {
    await rpc(params);
  } catch (error) {
    assertProof(error instanceof GatewayClientRequestError, "rejection was not a typed RPC error");
    assertProof(error.gatewayCode === "INVALID_REQUEST", `unexpected error ${error.gatewayCode}`);
    assertProof(isRecord(error.details), "rejection omitted details");
    assertProof(error.details.reason === "active-leaf-changed", "wrong rejection reason");
    return { code: error.gatewayCode, reason: error.details.reason };
  }
  throw new Error("stale leaf request was unexpectedly accepted");
}

async function history(
  client: GatewayClient,
  trace: Trace[],
  operationId: string,
  scenario: string,
): Promise<History> {
  return await rpc({
    client,
    trace,
    operationId,
    scenario,
    method: "chat.history",
    request: { sessionKey: SESSION_KEY, limit: 100 },
  });
}

function identity(value: History, label: string): { sessionId: string; leaf: string } {
  const sessionId = value.sessionId?.trim();
  const leaf = value.sessionInfo?.activeLeafEntryId?.trim();
  assertProof(sessionId, `${label}: missing sessionId`);
  assertProof(leaf, `${label}: missing active leaf`);
  return { sessionId, leaf };
}

async function turn(params: {
  client: GatewayClient;
  trace: Trace[];
  events: Array<{ event?: string; payload?: unknown }>;
  operationId: string;
  scenario: string;
  sessionId?: string;
  expectedLeafEntryId?: string;
}): Promise<{ runId: string; terminalEvent: { event: "chat"; state: "final" } }> {
  const runId = `run-${params.operationId}`;
  const started = await rpc<{ runId?: string; status?: string }>({
    ...params,
    method: "chat.send",
    request: {
      sessionKey: SESSION_KEY,
      sessionId: params.sessionId,
      expectedLeafEntryId: params.expectedLeafEntryId,
      message: `PR121332_${params.operationId.toUpperCase()}`,
      deliver: false,
      idempotencyKey: runId,
    },
  });
  assertProof(started.status === "started" && started.runId === runId, "chat.send did not start");
  const waited = await rpc<{ status?: string }>({
    ...params,
    operationId: `${params.operationId}-wait`,
    method: "agent.wait",
    request: { runId, timeoutMs: 120_000 },
    timeoutMs: 125_000,
  });
  assertProof(waited.status === "ok", "agent.wait was not ok");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const terminal = params.events.some((event) => {
      const payload = isRecord(event.payload) ? event.payload : {};
      return event.event === "chat" && payload.runId === runId && payload.state === "final";
    });
    if (terminal) {
      addTrace(params.trace, {
        kind: "gateway.event",
        operationId: params.operationId,
        scenario: params.scenario,
        event: "chat",
        runId,
        state: "final",
      });
      return { runId, terminalEvent: { event: "chat", state: "final" } };
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("terminal chat event missing");
}

async function snapshot(params: {
  client: GatewayClient;
  trace: Trace[];
  instance: OpenClawTestInstance;
  operationId: string;
  scenario: string;
  sessionId: string;
  providerCount: number;
}): Promise<StateSnapshot> {
  const storePath = path.join(params.instance.state.agentDir("main"), "openclaw-agent.sqlite");
  const scope = {
    agentId: "main",
    sessionKey: SESSION_KEY,
    sessionId: params.sessionId,
    storePath,
  };
  const visible = await history(params.client, params.trace, params.operationId, params.scenario);
  const visibleIdentity = identity(visible, `${params.operationId} snapshot`);
  const entry = loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY, storePath });
  const events = loadTranscriptEventsSync(scope);
  const messages = visible.messages ?? [];
  const entryJson = JSON.stringify(entry ?? null);
  const transcriptJson = JSON.stringify(events);
  const visibleJson = JSON.stringify(messages);
  return {
    durableDigest: sha256(JSON.stringify({ entry, events, messages })),
    sessionId: visibleIdentity.sessionId,
    activeLeafEntryId: visibleIdentity.leaf,
    entrySha256: sha256(entryJson),
    transcriptSha256: sha256(transcriptJson),
    visibleMessagesSha256: sha256(visibleJson),
    transcriptEventCount: events.length,
    visibleMessageCount: messages.length,
    providerCount: params.providerCount,
  };
}

function transcriptEntryFact(events: unknown[], entryId: string): Record<string, unknown> {
  const entry = events.find((candidate) => isRecord(candidate) && candidate.id === entryId);
  assertProof(isRecord(entry), `transcript entry ${entryId} is missing`);
  const message = isRecord(entry.message) ? entry.message : {};
  return {
    entryId,
    parentEntryId: typeof entry.parentId === "string" ? entry.parentId : null,
    type: entry.type,
    role: message.role,
    display: message.display,
  };
}

function hiddenAssistant(text: string) {
  return projectAgentHarnessTranscriptMessageForDisplay({
    hidden: true,
    message: makeAssistantMessageFixture({
      api: "openai-responses",
      provider: "pr121332-proof",
      model: "pr121332-proof",
      content: [{ type: "text", text }],
      stopReason: "stop",
      errorMessage: undefined,
      timestamp: Date.now(),
    }),
  });
}

function config(baseUrl: string): OpenClawConfig {
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
      entries: { main: { default: true } },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        "pr121332-proof": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "local-synthetic-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "pr121332-proof",
              name: "PR 121332 synthetic proof provider",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

function providerReply(response: ServerResponse, index: number): void {
  const text = `PR121332_SYNTHETIC_REPLY_${index}`;
  const message = {
    type: "message",
    id: `msg_pr121332_${index}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      delta: text,
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_pr121332_${index}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, { "cache-control": "no-store", "content-type": "text/event-stream" });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startProvider(trace: Trace[]): Promise<Provider> {
  const requests: Provider["requests"] = [];
  let phase = "bootstrap";
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "pr121332-proof", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const row = {
        index: requests.length + 1,
        phase,
        bodySha256: sha256(await requestText(request)),
      };
      requests.push(row);
      addTrace(trace, { kind: "provider.request", scenario: phase, ...row });
      providerReply(response, row.index);
    })().catch(() => response.writeHead(500).end("synthetic provider failure"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assertProof(address && typeof address !== "string", "provider did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    phase: (value) => {
      phase = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function safeFailure(error: unknown, secrets: string[]): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) {
    value = value.split(secret).join("[redacted]");
  }
  return value
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/gu,
      "[redacted]",
    )
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[A-Za-z0-9._/-]+/gu, "[temp-path]")
    .slice(0, 1_000);
}

async function startupDiagnostic(instance: OpenClawTestInstance | undefined): Promise<unknown> {
  try {
    const dir = path.join(instance!.stateDir, "logs", "stability");
    const name = (await readdir(dir))
      .filter((item) => item.endsWith(".json"))
      .toSorted()
      .at(-1);
    const bundle: unknown = name
      ? JSON.parse(await readFile(path.join(dir, name), "utf8"))
      : undefined;
    return isRecord(bundle) ? { reason: bundle.reason, error: bundle.error } : undefined;
  } catch {
    return undefined;
  }
}

async function writeEvidence(value: {
  trace: Trace[];
  scenarios: Scenario[];
  provider: Provider["requests"];
  cleanup: Record<string, boolean>;
  failure?: string;
  diagnostic?: unknown;
}): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    path.join(ARTIFACT_DIR, "trace.ndjson"),
    `${value.trace.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await writeFile(
    path.join(ARTIFACT_DIR, "cleanup.json"),
    `${JSON.stringify(value.cleanup, null, 2)}\n`,
  );
  await writeFile(
    path.join(ARTIFACT_DIR, "verdict.json"),
    `${JSON.stringify(
      {
        status: value.failure ? "fail" : "pass",
        identity: {
          headSha: fullSha("OPENCLAW_PR_121332_HEAD"),
          evidenceSha: fullSha("OPENCLAW_PR_121332_EVIDENCE_SHA"),
          baseSha: fullSha("OPENCLAW_PR_121332_BASE"),
          runId: process.env.GITHUB_RUN_ID ?? "local",
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
        },
        boundaries: {
          gateway: "real external ephemeral child process",
          transport: "native authenticated GatewayClient WebSocket/RPC",
          transcript: "real temporary SQLite through production owners",
          provider: "deterministic synthetic local HTTP",
          hiddenAdvanceProducer: "deterministic synthetic fixture via production SessionManager",
          branchFixture: "deterministic synthetic fixture via production SessionManager",
          media: "none",
          codexRuntime: "not exercised or claimed",
        },
        operationIdentity: "operationId + idempotencyKey/runId; not raw WebSocket frame IDs",
        scenarios: value.scenarios,
        ownerOperations: value.trace.filter((entry) => entry.kind === "transcript.owner.operation"),
        providerRequests: value.provider,
        diagnostic: value.diagnostic,
        failure: value.failure,
      },
      null,
      2,
    )}\n`,
  );
}

describe("PR #121332 exact-head real Gateway proof", () => {
  it(
    "accepts an active ancestor and rejects sibling and copied-exact stale-generation sends",
    { timeout: 180_000 },
    async () => {
      const trace: Trace[] = [];
      const scenarios: Scenario[] = [];
      const events: Array<{ event?: string; payload?: unknown }> = [];
      const cleanup = {
        clientWebSocket: false,
        gatewayInstance: false,
        providerServer: false,
        temporaryStateRemoved: false,
        clientDeviceStateRemoved: false,
      };
      let provider: Provider | undefined;
      let instance: OpenClawTestInstance | undefined;
      let client: GatewayClient | undefined;
      let clientIdentityPath: string | undefined;
      let failure: string | undefined;
      let diagnostic: unknown;
      try {
        provider = await startProvider(trace);
        instance = await createOpenClawTestInstance({
          name: "pr121332-exact-head-proof",
          config: config(provider.baseUrl),
          env: { OPENCLAW_SKIP_PROVIDERS: undefined },
        });
        await instance.startGateway();
        clientIdentityPath = path.join(instance.stateDir, "proof-client", "device-identity.sqlite");
        await mkdir(path.dirname(clientIdentityPath), { recursive: true });
        client = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          deviceIdentity: loadOrCreateDeviceIdentity({ path: clientIdentityPath }),
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          clientDisplayName: "pr121332-exact-head-proof",
          onEvent: (event) => events.push(event),
          requestTimeoutMs: 130_000,
        });
        addTrace(trace, {
          kind: "gateway.connected",
          operationId: "connect",
          process: "external-child",
        });

        await turn({ client, trace, events, operationId: "bootstrap", scenario: "bootstrap" });
        assertProof(provider.requests.length === 1, "bootstrap provider delta was not one");
        const renderedHistory = await history(
          client,
          trace,
          "history-rendered",
          "ancestor-accepted",
        );
        const rendered = identity(renderedHistory, "rendered history");
        const visibleBefore = sha256(JSON.stringify(renderedHistory.messages ?? []));
        const storePath = path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite");
        const manager = SessionManager.open({
          agentId: "main",
          sessionId: rendered.sessionId,
          sessionKey: SESSION_KEY,
          storePath,
        });
        const hiddenUser = manager.appendMessage(
          projectAgentHarnessTranscriptMessageForDisplay({
            hidden: true,
            message: { role: "user", content: "proof maintenance", timestamp: Date.now() },
          }),
        );
        ownerOperation(trace, "ancestor-accepted", "appendMessage", {
          entryId: hiddenUser,
          parentEntryId: rendered.leaf,
          role: "user",
          display: false,
        });
        const compaction = manager.appendCompaction(
          "proof background maintenance",
          rendered.leaf,
          10,
        );
        ownerOperation(trace, "ancestor-accepted", "appendCompaction", {
          entryId: compaction,
          parentEntryId: hiddenUser,
          firstKeptEntryId: rendered.leaf,
        });
        const hiddenAssistantLeaf = manager.appendMessage(hiddenAssistant("background append"));
        ownerOperation(trace, "ancestor-accepted", "appendMessage", {
          entryId: hiddenAssistantLeaf,
          parentEntryId: compaction,
          role: "assistant",
          display: false,
        });
        await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: storePath });
        const hiddenHistory = await history(client, trace, "history-hidden", "ancestor-accepted");
        const hidden = identity(hiddenHistory, "hidden-advance history");
        const hiddenVisibleDigest = sha256(JSON.stringify(hiddenHistory.messages ?? []));
        const hiddenEvents = loadTranscriptEventsSync({
          agentId: "main",
          sessionId: rendered.sessionId,
          sessionKey: SESSION_KEY,
          storePath,
        });
        const hiddenGraph = [hiddenUser, compaction, hiddenAssistantLeaf].map((entryId) =>
          transcriptEntryFact(hiddenEvents, entryId),
        );
        assertProof(
          hidden.sessionId === rendered.sessionId && hidden.leaf === hiddenAssistantLeaf,
          "hidden owner advance did not end at the hidden assistant leaf",
        );
        assertProof(hiddenGraph[0]?.parentEntryId === rendered.leaf, "hidden user parent mismatch");
        assertProof(hiddenGraph[0]?.role === "user", "hidden user role mismatch");
        assertProof(hiddenGraph[0]?.display === false, "hidden user was displayable");
        assertProof(hiddenGraph[1]?.parentEntryId === hiddenUser, "compaction parent mismatch");
        assertProof(hiddenGraph[1]?.type === "compaction", "compaction type mismatch");
        assertProof(
          hiddenGraph[2]?.parentEntryId === compaction,
          "hidden assistant parent mismatch",
        );
        assertProof(hiddenGraph[2]?.role === "assistant", "hidden assistant role mismatch");
        assertProof(hiddenGraph[2]?.display === false, "hidden assistant was displayable");
        assertProof(hiddenVisibleDigest === visibleBefore, "hidden turn became visible");

        provider.phase("ancestor-accepted");
        const acceptedProviderBefore = provider.requests.length;
        const acceptedTurn = await turn({
          client,
          trace,
          events,
          operationId: "ancestor-send",
          scenario: "ancestor-accepted",
          sessionId: rendered.sessionId,
          expectedLeafEntryId: rendered.leaf,
        });
        const acceptedDelta = provider.requests.length - acceptedProviderBefore;
        assertProof(acceptedDelta === 1, "ancestor send provider delta was not one");
        const acceptedHistory = await history(
          client,
          trace,
          "history-accepted",
          "ancestor-accepted",
        );
        const accepted = identity(acceptedHistory, "accepted history");
        const acceptedText = JSON.stringify(acceptedHistory.messages ?? []);
        assertProof(accepted.sessionId === rendered.sessionId, "accepted send rotated session");
        const acceptedEvents = loadTranscriptEventsSync({
          agentId: "main",
          sessionId: rendered.sessionId,
          sessionKey: SESSION_KEY,
          storePath,
        });
        const acceptedLeaf = transcriptEntryFact(acceptedEvents, accepted.leaf);
        const acceptedRelations = {
          L0: readSessionTranscriptActivePathEntryRelation(
            { agentId: "main", sessionId: rendered.sessionId, sessionKey: SESSION_KEY, storePath },
            rendered.leaf,
          ),
          L1: readSessionTranscriptActivePathEntryRelation(
            { agentId: "main", sessionId: rendered.sessionId, sessionKey: SESSION_KEY, storePath },
            accepted.leaf,
          ),
        };
        assertProof(
          acceptedRelations.L0 === "ancestor" && acceptedRelations.L1 === "exact",
          "accepted leaf relations mismatch",
        );
        const userPersisted = acceptedText.includes("PR121332_ANCESTOR-SEND");
        const assistantPersisted = acceptedText.includes("PR121332_SYNTHETIC_REPLY_2");
        assertProof(userPersisted, "user turn not persisted");
        assertProof(assistantPersisted, "assistant not persisted");
        scenarios.push({
          id: "same-generation-active-ancestor-accepted",
          outcome: "accepted",
          observed: {
            identities: {
              S1: rendered.sessionId,
              L0: rendered.leaf,
              hiddenLeaf: hiddenAssistantLeaf,
              L1: accepted.leaf,
            },
            hiddenAdvance: {
              producer: "production SessionManager",
              entries: hiddenGraph,
              visibleBeforeSha256: visibleBefore,
              visibleAfterSha256: hiddenVisibleDigest,
              visibleUnchanged: hiddenVisibleDigest === visibleBefore,
            },
            acceptedLeaf,
            relations: acceptedRelations,
            request: {
              operationId: "ancestor-send",
              runId: acceptedTurn.runId,
              sessionId: rendered.sessionId,
              expectedLeafEntryId: rendered.leaf,
              terminalEvent: acceptedTurn.terminalEvent,
            },
            provider: {
              before: acceptedProviderBefore,
              after: provider.requests.length,
              delta: acceptedDelta,
            },
            persistence: {
              userMarker: "PR121332_ANCESTOR-SEND",
              userPersisted,
              assistantMarker: "PR121332_SYNTHETIC_REPLY_2",
              assistantPersisted,
            },
          },
          assertions: ["hidden advance", "started/wait/final", "persisted user+assistant"],
        });

        const branches = SessionManager.open({
          agentId: "main",
          sessionId: rendered.sessionId,
          sessionKey: SESSION_KEY,
          storePath,
        });
        branches.branch(accepted.leaf);
        ownerOperation(trace, "sibling-rejected", "branch", {
          targetEntryId: accepted.leaf,
          nextFixture: "abandoned",
        });
        const abandoned = branches.appendMessage(hiddenAssistant("abandoned"));
        ownerOperation(trace, "sibling-rejected", "appendMessage", {
          entryId: abandoned,
          parentEntryId: accepted.leaf,
          role: "assistant",
          display: false,
        });
        await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: storePath });
        branches.branch(accepted.leaf);
        ownerOperation(trace, "sibling-rejected", "branch", {
          targetEntryId: accepted.leaf,
          nextFixture: "active",
        });
        const active = branches.appendMessage(hiddenAssistant("active"));
        ownerOperation(trace, "sibling-rejected", "appendMessage", {
          entryId: active,
          parentEntryId: accepted.leaf,
          role: "assistant",
          display: false,
        });
        await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: storePath });
        const branchEvents = loadTranscriptEventsSync({
          agentId: "main",
          sessionId: rendered.sessionId,
          sessionKey: SESSION_KEY,
          storePath,
        });
        const branchGraph = [abandoned, active].map((entryId) =>
          transcriptEntryFact(branchEvents, entryId),
        );
        assertProof(
          branchGraph.every(
            (entry) =>
              entry.parentEntryId === accepted.leaf &&
              entry.role === "assistant" &&
              entry.display === false,
          ),
          "branch fixture parent/role/display mismatch",
        );
        const listed = await rpc<{ branches?: Array<{ leafEntryId?: string; active?: boolean }> }>({
          client,
          trace,
          operationId: "branches-list",
          scenario: "sibling-rejected",
          method: "sessions.branches.list",
          request: { sessionKey: SESSION_KEY },
        });
        const abandonedBranch = listed.branches?.find((item) => item.leafEntryId === abandoned);
        const activeBranch = listed.branches?.find((item) => item.leafEntryId === active);
        assertProof(abandonedBranch?.active === false, "abandoned tip not inactive");
        assertProof(activeBranch?.active === true, "active tip mismatch");
        const siblingRelations = {
          L1: readSessionTranscriptActivePathEntryRelation(
            { agentId: "main", sessionId: rendered.sessionId, sessionKey: SESSION_KEY, storePath },
            accepted.leaf,
          ),
          B: readSessionTranscriptActivePathEntryRelation(
            { agentId: "main", sessionId: rendered.sessionId, sessionKey: SESSION_KEY, storePath },
            abandoned,
          ),
          T: readSessionTranscriptActivePathEntryRelation(
            { agentId: "main", sessionId: rendered.sessionId, sessionKey: SESSION_KEY, storePath },
            active,
          ),
        };
        assertProof(
          siblingRelations.L1 === "ancestor" &&
            siblingRelations.B === "off-path" &&
            siblingRelations.T === "exact",
          "sibling active-path relations mismatch",
        );
        provider.phase("sibling-rejected");
        const siblingProviderBefore = provider.requests.length;
        const siblingBefore = await snapshot({
          client,
          trace,
          instance,
          operationId: "sibling-before",
          scenario: "sibling-rejected",
          sessionId: rendered.sessionId,
          providerCount: provider.requests.length,
        });
        const siblingRejection = await expectLeafRejection({
          client,
          trace,
          operationId: "sibling-send",
          scenario: "sibling-rejected",
          method: "chat.send",
          request: {
            sessionKey: SESSION_KEY,
            sessionId: rendered.sessionId,
            expectedLeafEntryId: abandoned,
            message: "MUST_NOT_RUN",
            deliver: false,
            idempotencyKey: "run-sibling-send",
          },
        });
        const siblingAfter = await snapshot({
          client,
          trace,
          instance,
          operationId: "sibling-after",
          scenario: "sibling-rejected",
          sessionId: rendered.sessionId,
          providerCount: provider.requests.length,
        });
        assertProof(
          siblingAfter.durableDigest === siblingBefore.durableDigest,
          "sibling rejection changed state/provider count",
        );
        const siblingProviderAfter = provider.requests.length;
        assertProof(siblingProviderAfter === siblingProviderBefore, "sibling request hit provider");
        scenarios.push({
          id: "off-path-sibling-rejected",
          outcome: "rejected",
          observed: {
            identities: {
              S1: rendered.sessionId,
              L1: accepted.leaf,
              B: abandoned,
              T: active,
            },
            branchGraph,
            branchList: {
              abandonedActive: abandonedBranch.active,
              activeTipActive: activeBranch.active,
            },
            relations: siblingRelations,
            request: {
              operationId: "sibling-send",
              sessionId: rendered.sessionId,
              expectedLeafEntryId: abandoned,
            },
            error: siblingRejection,
            provider: {
              before: siblingProviderBefore,
              after: siblingProviderAfter,
              delta: siblingProviderAfter - siblingProviderBefore,
            },
            state: {
              before: siblingBefore,
              after: siblingAfter,
              durableDigestUnchanged: siblingAfter.durableDigest === siblingBefore.durableDigest,
            },
          },
          assertions: ["INVALID_REQUEST/active-leaf-changed", "durable digest unchanged"],
        });

        provider.phase("copied-exact-stale-generation-rejected");
        const rotatedProviderBefore = provider.requests.length;
        const switched = await rpc<Record<string, never>>({
          client,
          trace,
          operationId: "branch-switch",
          scenario: "copied-exact-stale-generation-rejected",
          method: "sessions.branches.switch",
          request: { sessionKey: SESSION_KEY, leafEntryId: abandoned },
        });
        assertProof(Object.keys(switched).length === 0, "branch switch response was not {}");
        const rotatedHistory = await history(
          client,
          trace,
          "history-rotated",
          "copied-exact-stale-generation-rejected",
        );
        const rotated = identity(rotatedHistory, "rotated history");
        assertProof(
          rotated.sessionId !== rendered.sessionId,
          "branch switch did not rotate sessionId",
        );
        assertProof(rotated.leaf === abandoned, "branch switch did not activate abandoned leaf B");
        const relationL1 = readSessionTranscriptActivePathEntryRelation(
          { agentId: "main", sessionId: rotated.sessionId, sessionKey: SESSION_KEY, storePath },
          accepted.leaf,
        );
        const relationB = readSessionTranscriptActivePathEntryRelation(
          { agentId: "main", sessionId: rotated.sessionId, sessionKey: SESSION_KEY, storePath },
          abandoned,
        );
        assertProof(relationL1 === "ancestor", "old leaf was not a new-generation ancestor");
        assertProof(relationB === "exact", "switched leaf B was not exact active leaf");
        const rotatedBefore = await snapshot({
          client,
          trace,
          instance,
          operationId: "rotated-before",
          scenario: "copied-exact-stale-generation-rejected",
          sessionId: rotated.sessionId,
          providerCount: provider.requests.length,
        });
        const rotatedRejection = await expectLeafRejection({
          client,
          trace,
          operationId: "rotated-stale-send",
          scenario: "copied-exact-stale-generation-rejected",
          method: "chat.send",
          request: {
            sessionKey: SESSION_KEY,
            sessionId: rendered.sessionId,
            expectedLeafEntryId: abandoned,
            message: "MUST_NOT_RUN",
            deliver: false,
            idempotencyKey: "run-rotated-stale-send",
          },
        });
        const rotatedAfter = await snapshot({
          client,
          trace,
          instance,
          operationId: "rotated-after",
          scenario: "copied-exact-stale-generation-rejected",
          sessionId: rotated.sessionId,
          providerCount: provider.requests.length,
        });
        assertProof(
          rotatedAfter.durableDigest === rotatedBefore.durableDigest,
          "rotated rejection changed state/provider count",
        );
        const rotatedProviderAfter = provider.requests.length;
        assertProof(rotatedProviderAfter === rotatedProviderBefore, "rotated request hit provider");
        scenarios.push({
          id: "branch-switch-copied-exact-stale-generation-rejected",
          outcome: "rejected",
          observed: {
            identities: {
              S1: rendered.sessionId,
              L1: accepted.leaf,
              B: abandoned,
              S2: rotated.sessionId,
              switchedActiveLeaf: rotated.leaf,
            },
            branchSwitch: {
              operationId: "branch-switch",
              requestLeafEntryId: abandoned,
              response: switched,
              sessionIdRotated: rotated.sessionId !== rendered.sessionId,
            },
            relations: { L1: relationL1, B: relationB },
            request: {
              operationId: "rotated-stale-send",
              staleSessionId: rendered.sessionId,
              expectedLeafEntryId: abandoned,
              currentSessionId: rotated.sessionId,
              copiedLeafIsCurrentExact: abandoned === rotated.leaf && relationB === "exact",
            },
            error: rotatedRejection,
            provider: {
              before: rotatedProviderBefore,
              after: rotatedProviderAfter,
              delta: rotatedProviderAfter - rotatedProviderBefore,
            },
            state: {
              before: rotatedBefore,
              after: rotatedAfter,
              durableDigestUnchanged: rotatedAfter.durableDigest === rotatedBefore.durableDigest,
            },
          },
          assertions: [
            "new sessionId",
            "copied leaf B is current exact leaf in S2",
            "stale S1 + exact B rejected with INVALID_REQUEST/active-leaf-changed",
            "provider delta zero",
            "durable S2 digest unchanged",
          ],
        });
      } catch (error) {
        failure = safeFailure(error, [instance?.gatewayToken ?? "", instance?.hookToken ?? ""]);
        diagnostic = await startupDiagnostic(instance);
      } finally {
        if (client) {
          await disconnectGatewayClient(client)
            .then(() => {
              cleanup.clientWebSocket = true;
            })
            .catch(() => {});
        }
        if (instance) {
          const stateDir = instance.stateDir;
          await instance
            .cleanup()
            .then(() => {
              cleanup.gatewayInstance = true;
            })
            .catch(() => {});
          await access(stateDir).catch(() => {
            cleanup.temporaryStateRemoved = true;
          });
          if (clientIdentityPath) {
            await access(clientIdentityPath).catch(() => {
              cleanup.clientDeviceStateRemoved = true;
            });
          }
        }
        if (provider) {
          await provider
            .close()
            .then(() => {
              cleanup.providerServer = true;
            })
            .catch(() => {});
        }
      }
      if (!Object.values(cleanup).every(Boolean)) {
        failure ??= "ephemeral cleanup incomplete";
      }
      await writeEvidence({
        trace,
        scenarios,
        provider: provider?.requests ?? [],
        cleanup,
        failure,
        diagnostic,
      });
      assertProof(!failure, failure ?? "proof failed");
    },
  );
});
