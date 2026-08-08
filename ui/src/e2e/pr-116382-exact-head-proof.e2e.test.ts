// Evidence-branch-only exact-head real-Gateway browser proof for PR #116382.
/* oxlint-disable max-lines -- temporary exact-head evidence harness is one auditable scenario. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
  switchSessionBranch,
} from "../../../src/config/sessions/session-accessor.js";
import type { GatewayClient } from "../../../src/gateway/client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.js";
import { runExclusiveSessionLifecycleMutation } from "../../../src/sessions/session-lifecycle-admission.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeProof = chromiumAvailable ? describe : describe.skip;
const artifactDir = path.resolve(
  process.env.OPENCLAW_PR_116382_PROOF_DIR ??
    path.join(process.cwd(), ".artifacts", "control-ui-e2e", "pr-116382-exact-head"),
);
const proofSessionKey = "agent:main:main";
const samePathPrompt = "send after same-path background progress";
const samePathReply = "Same-path ancestor accepted by the real Gateway.";
const prompt = "retry this queued turn after the authoritative branch changes";
const reply = "Single refreshed retry accepted by the real Gateway.";
const storeName = "sessions.json";
const waitTimeoutMs = 60_000;
const screenshotAssets = [
  "00-same-path-ancestor-accepted.png",
  "01-stale-revision-queued-offline.png",
  "02-branch-rejected-history-held.png",
  "03-single-retry-blocked-while-history-held.png",
  "04-single-refreshed-retry-accepted.png",
] as const;

function requireFullSha(name: string): string {
  const value = process.env[name];
  if (!value || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${name} must be an exact 40-character lowercase commit SHA`);
  }
  return value;
}

const candidateHeadSha = requireFullSha("OPENCLAW_PR_116382_HEAD");
const candidateBaseSha = requireFullSha("OPENCLAW_PR_116382_BASE");
const evidenceTipSha = requireFullSha("OPENCLAW_PR_116382_EVIDENCE_SHA");

type ModelRequest = { body: Record<string, unknown> };
type SyntheticModelServer = {
  baseUrl: string;
  requests: ModelRequest[];
  stop: () => Promise<void>;
};
type ObservedGatewayRequest = {
  method: "chat.history" | "chat.send";
  params: Record<string, unknown>;
  requestId: string;
};
type ObservedGatewayResponse = {
  error?: unknown;
  ok?: unknown;
  payload?: unknown;
  requestId: string;
  requestMethod: "chat.history" | "chat.send";
};
type ObservedChatSend = {
  deliver?: unknown;
  expectedLeafEntryId?: unknown;
  expectedRunId?: unknown;
  idempotencyKey?: unknown;
  message?: unknown;
  queueMode?: unknown;
  requestId: string;
  sessionId?: unknown;
  sessionKey?: unknown;
};
type BrowserHistoryGateState = {
  heldHistoryRequestIds: string[];
  heldHistoryResponseSequence: number | null;
  heldHistoryResponse: {
    activeLeafEntryId: unknown;
    activeRunIds: unknown;
    messageCount: number;
    ok: unknown;
    requestId: string;
    sessionId: unknown;
  } | null;
  historyHeld: boolean;
  historyReleased: boolean;
  historyResponseArrived: boolean;
  installedBeforePage: boolean;
  postRejectionHistoryRequests: number;
  rejectedSendObserved: boolean;
  rejectedSendRequestId: string | null;
  releasedAfterTraceSequence: number | null;
  releasedAt: string | null;
  routeConnections: number;
};
type NativeWebSocketTraceEntry = {
  at: string;
  direction: "browser-to-gateway" | "gateway-to-browser";
  frame: Record<string, unknown>;
  sequence: number;
};
type BrowserHistoryGate = {
  observedGatewayRequests: ObservedGatewayRequest[];
  observedGatewayResponses: ObservedGatewayResponse[];
  observedChatSends: ObservedChatSend[];
  release: () => void;
  state: BrowserHistoryGateState;
  trace: NativeWebSocketTraceEntry[];
};

let browser: Browser;
let uiServer: ControlUiE2eServer;
let instance: OpenClawTestInstance;
let modelServer: SyntheticModelServer;
let controller: GatewayClient | undefined;
const proof: Record<string, unknown> = {
  mergeBaseSha: candidateBaseSha,
  dataClassification: "synthetic-redacted",
  evidenceTipSha,
  gatewayMode: "real-ephemeral-process",
  headSha: candidateHeadSha,
  mockGateway: false,
  proofSessionKey,
  providerBoundary: "synthetic-local-http",
  scenarioCount: 1,
  startedAt: new Date().toISOString(),
  status: "running",
  websocket: "real-browser-native-via-playwright-transparent-route",
};

function requireRecord(value: unknown, label = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function parseWireMessage(message: string | Buffer): Record<string, unknown> | null {
  try {
    return requireRecord(JSON.parse(message.toString()), "Gateway WebSocket frame");
  } catch {
    return null;
  }
}

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? requireRecord(JSON.parse(body), "model request") : {};
}

function writeResponsesReply(res: ServerResponse, text: string, index: number): void {
  const message = {
    content: [{ annotations: [], text, type: "output_text" }],
    id: `msg_pr_116382_${index}`,
    role: "assistant",
    status: "completed",
    type: "message",
  };
  const events = [
    {
      item: { ...message, content: [], status: "in_progress" },
      output_index: 0,
      type: "response.output_item.added",
    },
    {
      content_index: 0,
      delta: text,
      item_id: message.id,
      output_index: 0,
      type: "response.output_text.delta",
    },
    {
      content_index: 0,
      item_id: message.id,
      output_index: 0,
      text,
      type: "response.output_text.done",
    },
    { item: message, output_index: 0, type: "response.output_item.done" },
    {
      response: {
        id: `resp_pr_116382_${index}`,
        output: [message],
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      type: "response.completed",
    },
  ];
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/event-stream",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function startSyntheticModelServer(): Promise<SyntheticModelServer> {
  const requests: ModelRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "pr-116382-proof", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = await readJsonRequest(req);
      requests.push({ body });
      writeResponsesReply(
        res,
        JSON.stringify(body).includes(samePathPrompt) ? samePathReply : reply,
        requests.length,
      );
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("synthetic model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sessionStorePath(): string {
  return path.join(instance.state.sessionsDir("main"), storeName);
}

async function seedSession(params: {
  events: Array<{ content: string; eventId: string; parentId: string | null }>;
  sessionId: string;
}): Promise<void> {
  const storePath = sessionStorePath();
  await replaceSessionEntry(
    { agentId: "main", sessionKey: proofSessionKey, storePath },
    { lifecycleRevision: randomUUID(), sessionId: params.sessionId, updatedAt: Date.now() },
  );
  for (const [index, event] of params.events.entries()) {
    await appendTranscriptMessage(
      {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: proofSessionKey,
        storePath,
      },
      {
        eventId: event.eventId,
        message: { content: event.content, role: "assistant" },
        now: Date.now() + index,
        parentId: event.parentId,
      },
    );
  }
}

async function connectController(): Promise<GatewayClient> {
  return await connectGatewayClient({
    clientDisplayName: "PR 116382 evidence controller",
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: path.join(instance.stateDir, "proof-controller-device.sqlite"),
    }),
    requestTimeoutMs: 30_000,
    scopes: ["operator.admin", "operator.read", "operator.write"],
    token: instance.gatewayToken,
    url: instance.url,
  });
}

async function closeController(): Promise<void> {
  const current = controller;
  controller = undefined;
  if (current) {
    await disconnectGatewayClient(current).catch(() => undefined);
  }
}

async function collectScreenshotEvidence(): Promise<Array<{ asset: string; sha256: string }>> {
  return await Promise.all(
    screenshotAssets.map(async (asset) => ({
      asset,
      sha256: createHash("sha256")
        .update(await readFile(path.join(artifactDir, asset)))
        .digest("hex"),
    })),
  );
}

function assertRedactedEvidence(serialized: string): void {
  const forbiddenValues = [instance?.gatewayToken, "synthetic-local-only"].filter(
    (value): value is string => Boolean(value),
  );
  if (
    forbiddenValues.some((value) => serialized.includes(value)) ||
    /(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:/iu.test(
      serialized,
    ) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu.test(serialized)
  ) {
    throw new Error("structured proof contained forbidden authentication material");
  }
}

function sanitizeTraceFrame(
  frame: Record<string, unknown>,
  requestMethod?: "chat.history" | "chat.send",
): Record<string, unknown> {
  if (frame.type === "req") {
    const method = frame.method;
    if (method !== "chat.history" && method !== "chat.send") {
      return { ignored: true, type: frame.type };
    }
    const params = requireRecord(frame.params, `${method} params`);
    return {
      id: frame.id,
      method,
      params:
        method === "chat.send"
          ? {
              deliver: params.deliver,
              expectedLeafEntryId: params.expectedLeafEntryId,
              expectedRunId: params.expectedRunId,
              idempotencyKey: params.idempotencyKey,
              message: params.message,
              queueMode: params.queueMode,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            }
          : { limit: params.limit, sessionKey: params.sessionKey },
      type: frame.type,
    };
  }
  if (frame.type === "res" && requestMethod) {
    const error =
      frame.error && typeof frame.error === "object" && !Array.isArray(frame.error)
        ? (frame.error as Record<string, unknown>)
        : undefined;
    const details =
      error?.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : undefined;
    const payload =
      frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
        ? (frame.payload as Record<string, unknown>)
        : undefined;
    const sessionInfo =
      payload?.sessionInfo &&
      typeof payload.sessionInfo === "object" &&
      !Array.isArray(payload.sessionInfo)
        ? (payload.sessionInfo as Record<string, unknown>)
        : undefined;
    return {
      error: error
        ? { code: error.code, details: details ? { reason: details.reason } : undefined }
        : undefined,
      id: frame.id,
      ok: frame.ok,
      payload:
        requestMethod === "chat.history" && payload
          ? {
              messageCount: Array.isArray(payload.messages) ? payload.messages.length : null,
              sessionId: payload.sessionId,
              sessionInfo: sessionInfo
                ? {
                    activeLeafEntryId: sessionInfo.activeLeafEntryId,
                    activeRunIds: sessionInfo.activeRunIds,
                  }
                : null,
            }
          : requestMethod === "chat.send" && payload
            ? { runId: payload.runId, status: payload.status }
            : undefined,
      requestMethod,
      type: frame.type,
    };
  }
  if (frame.type === "event" && (frame.event === "chat" || frame.event === "agent")) {
    const payload =
      frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
        ? (frame.payload as Record<string, unknown>)
        : {};
    return {
      event: frame.event,
      payload: {
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        state: payload.state,
        stream: payload.stream,
      },
      type: frame.type,
    };
  }
  return { ignored: true, type: frame.type };
}

async function createRealGatewayPage(): Promise<{
  context: BrowserContext;
  historyGate: BrowserHistoryGate;
  page: Page;
}> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  await context.addInitScript(
    ({ gatewayUrl, token }) => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
    },
    { gatewayUrl: instance.url, token: instance.gatewayToken },
  );

  const state: BrowserHistoryGateState = {
    heldHistoryRequestIds: [],
    heldHistoryResponse: null,
    heldHistoryResponseSequence: null,
    historyHeld: false,
    historyReleased: false,
    historyResponseArrived: false,
    installedBeforePage: true,
    postRejectionHistoryRequests: 0,
    rejectedSendObserved: false,
    rejectedSendRequestId: null,
    releasedAfterTraceSequence: null,
    releasedAt: null,
    routeConnections: 0,
  };
  const observedGatewayRequests: ObservedGatewayRequest[] = [];
  const observedGatewayResponses: ObservedGatewayResponse[] = [];
  const observedChatSends: ObservedChatSend[] = [];
  const trace: NativeWebSocketTraceEntry[] = [];
  const requestMethods = new Map<string, "chat.history" | "chat.send">();
  const postRejectionHistoryRequestIds = new Set<string>();
  const heldDeliveries: Array<{ message: string | Buffer; route: WebSocketRoute }> = [];
  let sequence = 0;

  const recordTrace = (
    direction: NativeWebSocketTraceEntry["direction"],
    frame: Record<string, unknown>,
    requestMethod?: "chat.history" | "chat.send",
  ): number | null => {
    const sanitized = sanitizeTraceFrame(frame, requestMethod);
    if (sanitized.ignored === true) {
      return null;
    }
    const currentSequence = ++sequence;
    trace.push({
      at: new Date().toISOString(),
      direction,
      frame: sanitized,
      sequence: currentSequence,
    });
    return currentSequence;
  };

  const gatewayOrigin = new URL(instance.url).origin;
  await context.routeWebSocket(
    (url) => url.origin === gatewayOrigin,
    (pageSocket) => {
      state.routeConnections += 1;
      const serverSocket = pageSocket.connectToServer();
      pageSocket.onMessage((message) => {
        const frame = parseWireMessage(message);
        if (
          frame?.type === "req" &&
          (frame.method === "chat.send" || frame.method === "chat.history")
        ) {
          const method = frame.method;
          const requestId = requireNonEmptyString(frame.id, `${method} request ID`);
          const params = requireRecord(frame.params, `${method} params`);
          requestMethods.set(requestId, method);
          observedGatewayRequests.push({ method, params, requestId });
          recordTrace("browser-to-gateway", frame);
          if (method === "chat.send") {
            observedChatSends.push({
              deliver: params.deliver,
              expectedLeafEntryId: params.expectedLeafEntryId,
              expectedRunId: params.expectedRunId,
              idempotencyKey: params.idempotencyKey,
              message: params.message,
              queueMode: params.queueMode,
              requestId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            });
          } else if (state.rejectedSendObserved && !state.historyReleased) {
            state.postRejectionHistoryRequests += 1;
            postRejectionHistoryRequestIds.add(requestId);
          }
        }
        serverSocket.send(message);
      });
      serverSocket.onMessage((message) => {
        const frame = parseWireMessage(message);
        const responseId = frame?.type === "res" && typeof frame.id === "string" ? frame.id : null;
        const requestMethod = responseId ? requestMethods.get(responseId) : undefined;
        const recordedTraceSequence =
          frame && (requestMethod || frame.type === "event")
            ? recordTrace("gateway-to-browser", frame, requestMethod)
            : null;
        if (frame?.type === "res" && responseId && requestMethod) {
          observedGatewayResponses.push({
            error: frame.error,
            ok: frame.ok,
            payload: frame.payload,
            requestId: responseId,
            requestMethod,
          });
          if (requestMethod === "chat.send" && frame.ok === false) {
            const error = requireRecord(frame.error, "chat.send Gateway error");
            const details = requireRecord(error.details, "chat.send Gateway error details");
            if (details.reason === "active-leaf-changed") {
              state.rejectedSendObserved = true;
              state.rejectedSendRequestId = responseId;
            }
          }
          if (
            requestMethod === "chat.history" &&
            postRejectionHistoryRequestIds.has(responseId) &&
            !state.historyReleased
          ) {
            const payload = requireRecord(frame.payload, "held chat.history payload");
            const sessionInfo = requireRecord(payload.sessionInfo, "held chat.history sessionInfo");
            state.historyHeld = true;
            state.historyResponseArrived = true;
            state.heldHistoryRequestIds.push(responseId);
            state.heldHistoryResponseSequence ??= recordedTraceSequence;
            state.heldHistoryResponse ??= {
              activeLeafEntryId: sessionInfo.activeLeafEntryId,
              activeRunIds: sessionInfo.activeRunIds,
              messageCount: Array.isArray(payload.messages) ? payload.messages.length : -1,
              ok: frame.ok,
              requestId: responseId,
              sessionId: payload.sessionId,
            };
            heldDeliveries.push({ message, route: pageSocket });
            return;
          }
        }
        pageSocket.send(message);
      });
    },
  );

  const historyGate: BrowserHistoryGate = {
    observedGatewayRequests,
    observedGatewayResponses,
    observedChatSends,
    release: () => {
      if (!state.historyHeld || heldDeliveries.length === 0) {
        throw new Error("post-rejection chat.history response has not been held");
      }
      if (state.historyReleased) {
        return;
      }
      state.releasedAfterTraceSequence = trace.at(-1)?.sequence ?? 0;
      state.historyReleased = true;
      state.releasedAt = new Date().toISOString();
      for (const delivery of heldDeliveries.splice(0)) {
        delivery.route.send(delivery.message);
      }
    },
    state,
    trace,
  };
  const page = await context.newPage();
  page.setDefaultTimeout(waitTimeoutMs);
  return { context, historyGate, page };
}

async function waitForGatewayPhase(page: Page, phase: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } };
          };
          return app.runtime?.context?.gateway?.snapshot?.phase;
        }),
      { timeout: waitTimeoutMs },
    )
    .toBe(phase);
}

async function waitForUniqueChatLogText(page: Page, text: string): Promise<void> {
  const message = page.getByRole("log").getByText(text, { exact: true });
  await expect.poll(async () => await message.count(), { timeout: waitTimeoutMs }).toBe(1);
  await message.waitFor({ state: "visible", timeout: waitTimeoutMs });
}

async function readPersistedQueueItem(page: Page, expectedPrompt: string) {
  return await page.evaluate((expectedText) => {
    for (const [key, value] of Object.entries(sessionStorage)) {
      if (!key.startsWith("openclaw.control.chatComposer.v2:")) {
        continue;
      }
      try {
        const parsed = JSON.parse(value) as {
          sessions?: Record<
            string,
            {
              queue?: Array<{
                id?: unknown;
                sendError?: unknown;
                sendState?: unknown;
                text?: unknown;
                transcriptRevision?: unknown;
              }>;
            }
          >;
        };
        const item = Object.values(parsed.sessions ?? {})
          .flatMap((session) => session.queue ?? [])
          .find((candidate) => candidate.text === expectedText);
        if (item) {
          return item;
        }
      } catch {
        // Ignore unrelated malformed browser storage in this focused proof.
      }
    }
    return null;
  }, expectedPrompt);
}

async function readBrowserRevision(page: Page): Promise<{
  activeLeafEntryId: unknown;
  displayedLeafEntryId: unknown;
}> {
  return await page.evaluate((sessionKey) => {
    const pane = document.querySelector("openclaw-chat-pane") as HTMLElement & {
      state?: {
        chatDisplayedLeafEntryId?: unknown;
        sessionsResult?: { sessions?: Array<Record<string, unknown>> } | null;
      };
    };
    const state = pane?.state;
    const session = state?.sessionsResult?.sessions?.find((row) => row.key === sessionKey);
    return {
      activeLeafEntryId: session?.activeLeafEntryId,
      displayedLeafEntryId: state?.chatDisplayedLeafEntryId,
    };
  }, proofSessionKey);
}

describeProof("PR #116382 exact-head real Gateway single-retry proof", () => {
  beforeAll(async () => {
    await mkdir(artifactDir, { recursive: true });
    uiServer = await startControlUiE2eServer();
    modelServer = await startSyntheticModelServer();
    const modelRef = "pr-116382-proof/pr-116382-proof";
    instance = await createOpenClawTestInstance({
      name: "pr-116382-real-proof",
      config: {
        agents: {
          defaults: {
            model: { primary: modelRef },
            models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
            skills: [],
            skipBootstrap: true,
            workspace: path.join(artifactDir, "workspace"),
          },
          list: [{ default: true, id: "main", model: { primary: modelRef }, skills: [] }],
        },
        gateway: {
          controlUi: {
            allowedOrigins: [new URL(uiServer.baseUrl).origin],
            enabled: false,
          },
        },
        models: {
          mode: "replace",
          providers: {
            "pr-116382-proof": {
              api: "openai-responses",
              apiKey: "synthetic-local-only",
              baseUrl: `${modelServer.baseUrl}/v1`,
              models: [
                {
                  api: "openai-responses",
                  contextWindow: 128_000,
                  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                  id: "pr-116382-proof",
                  input: ["text"],
                  maxTokens: 4_096,
                  name: "PR 116382 deterministic proof",
                  reasoning: false,
                },
              ],
              request: { allowPrivateNetwork: true },
            },
          },
        },
        plugins: { enabled: false },
        tools: { profile: "minimal" },
      },
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      gatewayToken: "pr-116382-synthetic-gateway-token",
      startTimeoutMs: 120_000,
    });
    await instance.startGateway();
    controller = await connectController();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 180_000);

  afterAll(async () => {
    try {
      proof.finishedAt = new Date().toISOString();
      proof.status =
        requireRecord(proof.branchRejectionSingleRetry ?? {}).status === "pass"
          ? "pass"
          : "incomplete";
      const serializedProof = `${JSON.stringify(proof, null, 2)}\n`;
      assertRedactedEvidence(serializedProof);
      await writeFile(path.join(artifactDir, "pr-116382-exact-head-proof.json"), serializedProof);
    } finally {
      await closeController();
      await browser?.close().catch(() => undefined);
      await instance?.cleanup().catch(() => undefined);
      await modelServer?.stop().catch(() => undefined);
      await uiServer?.close().catch(() => undefined);
    }
  });

  it("releases one held refresh into exactly one retry with the new revision", async () => {
    const sourceSessionId = "pr-116382-generation-before-switch";
    const rootLeaf = "pr-116382-rotation-root";
    const switchedLeaf = "pr-116382-rotation-alternate";
    const renderedLeaf = "pr-116382-rotation-rendered";
    const backgroundLeaf = "pr-116382-same-path-background";
    const providerRequestsAtStart = modelServer.requests.length;
    await seedSession({
      sessionId: sourceSessionId,
      events: [
        { content: "Choose a branch.", eventId: rootLeaf, parentId: null },
        {
          content: "A different branch will become authoritative.",
          eventId: switchedLeaf,
          parentId: rootLeaf,
        },
        {
          content: "Queue this turn before switching branches.",
          eventId: renderedLeaf,
          parentId: rootLeaf,
        },
      ],
    });
    const { context, historyGate, page } = await createRealGatewayPage();
    let gatewayStopped = false;
    let retryClicks = 0;
    const operatorTimeline: Array<{
      at: string;
      chatSendCount: number;
      name: string;
      providerRequestCount: number;
    }> = [];
    const recordMilestone = (name: string) => {
      operatorTimeline.push({
        at: new Date().toISOString(),
        chatSendCount: historyGate.observedChatSends.length,
        name,
        providerRequestCount: modelServer.requests.length,
      });
    };

    try {
      await page.goto(`${uiServer.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
      await page
        .locator(".chat-thread-inner .chat-text", {
          hasText: "Queue this turn before switching branches.",
        })
        .waitFor();

      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionId: sourceSessionId,
          sessionKey: proofSessionKey,
          storePath: sessionStorePath(),
        },
        {
          eventId: backgroundLeaf,
          message: {
            content: "Background progress stayed on the rendered path.",
            role: "assistant",
          },
          now: Date.now(),
          parentId: renderedLeaf,
        },
      );
      const samePathAuthoritativeHistory = requireRecord(
        await controller!.request("chat.history", { limit: 100, sessionKey: proofSessionKey }),
        "same-path authoritative pre-send history",
      );
      const samePathAuthoritativeSessionInfo = requireRecord(
        samePathAuthoritativeHistory.sessionInfo,
        "same-path authoritative pre-send sessionInfo",
      );
      expect(samePathAuthoritativeHistory.sessionId).toBe(sourceSessionId);
      expect(samePathAuthoritativeSessionInfo.activeLeafEntryId).toBe(backgroundLeaf);
      expect(
        requireStringArray(
          samePathAuthoritativeSessionInfo.activeRunIds,
          "same-path authoritative pre-send active run IDs",
        ),
      ).toEqual([]);
      const samePathBrowserRevisionBeforeSend = await readBrowserRevision(page);
      expect(samePathBrowserRevisionBeforeSend.displayedLeafEntryId).toBe(renderedLeaf);
      expect(samePathBrowserRevisionBeforeSend.displayedLeafEntryId).not.toBe(backgroundLeaf);
      await page.locator(".agent-chat__composer-combobox textarea").fill(samePathPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => historyGate.observedChatSends.length).toBe(1);
      const samePathSend = historyGate.observedChatSends[0]!;
      expect(samePathSend).toMatchObject({
        expectedLeafEntryId: renderedLeaf,
        message: samePathPrompt,
        sessionId: sourceSessionId,
        sessionKey: proofSessionKey,
      });
      await expect
        .poll(() =>
          historyGate.observedGatewayResponses.some(
            (response) => response.requestId === samePathSend.requestId && response.ok === true,
          ),
        )
        .toBe(true);
      await expect.poll(() => modelServer.requests.length).toBe(providerRequestsAtStart + 1);
      await waitForUniqueChatLogText(page, samePathReply);
      recordMilestone("same-path-accepted");

      let queuedSourceLeaf = "";
      await expect
        .poll(async () => {
          const history = requireRecord(
            await controller!.request("chat.history", { limit: 100, sessionKey: proofSessionKey }),
            "same-path terminal history",
          );
          const sessionInfo = requireRecord(history.sessionInfo, "same-path sessionInfo");
          const activeRunIds = requireStringArray(
            sessionInfo.activeRunIds,
            "same-path active run IDs",
          );
          if (
            activeRunIds.length !== 0 ||
            !JSON.stringify(history.messages).includes(samePathReply) ||
            typeof sessionInfo.activeLeafEntryId !== "string"
          ) {
            return false;
          }
          queuedSourceLeaf = sessionInfo.activeLeafEntryId;
          return queuedSourceLeaf !== renderedLeaf && queuedSourceLeaf !== backgroundLeaf;
        })
        .toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForUniqueChatLogText(page, samePathReply);
      await expect
        .poll(async () => (await readBrowserRevision(page)).displayedLeafEntryId)
        .toBe(queuedSourceLeaf);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "00-same-path-ancestor-accepted.png"),
      });

      await closeController();
      await instance.stopGateway();
      gatewayStopped = true;
      await waitForGatewayPhase(page, "reconnecting");
      await page.locator(".agent-chat__offline-hint").waitFor({ timeout: 15_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const queue = page.locator(".chat-queue");
      await queue.getByText("Waiting for reconnect").waitFor();
      await queue.getByText(prompt, { exact: true }).waitFor();
      const storedBeforeSwitch = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored queue before branch switch",
      );
      expect(storedBeforeSwitch.transcriptRevision).toEqual({
        expectedLeafEntryId: queuedSourceLeaf,
        sessionId: sourceSessionId,
      });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "01-stale-revision-queued-offline.png"),
      });

      let switchedSessionId = "";
      await runExclusiveSessionLifecycleMutation({
        identities: [proofSessionKey, sourceSessionId],
        scope: sessionStorePath(),
        run: async () => {
          const switched = await switchSessionBranch({
            agentId: "main",
            leafEntryId: switchedLeaf,
            sessionKey: proofSessionKey,
            storePath: sessionStorePath(),
          });
          if (switched.status !== "created") {
            throw new Error(`expected canonical branch creation, got ${switched.status}`);
          }
          switchedSessionId = switched.entry.sessionId;
        },
      });
      expect(switchedSessionId).not.toBe(sourceSessionId);
      expect(
        loadSessionEntry({ sessionKey: proofSessionKey, storePath: sessionStorePath() })?.sessionId,
      ).toBe(switchedSessionId);

      await page.reload({ waitUntil: "domcontentloaded" });
      const storedAfterReload = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored queue after offline reload",
      );
      const storedAfterReloadRevision = requireRecord(
        storedAfterReload.transcriptRevision,
        "stored queue revision after offline reload",
      );
      expect(storedAfterReloadRevision).toEqual({
        expectedLeafEntryId: queuedSourceLeaf,
        sessionId: sourceSessionId,
      });
      expect(historyGate.state.installedBeforePage).toBe(true);
      expect(modelServer.requests).toHaveLength(providerRequestsAtStart + 1);

      await instance.startGateway();
      gatewayStopped = false;
      controller = await connectController();
      await waitForGatewayPhase(page, "connected");
      await page
        .locator(".chat-thread-inner .chat-text", {
          hasText: "A different branch will become authoritative.",
        })
        .waitFor();

      await expect.poll(() => historyGate.observedChatSends.length).toBe(2);
      const rejectedSend = historyGate.observedChatSends[1]!;
      expect(rejectedSend).toMatchObject({
        expectedLeafEntryId: queuedSourceLeaf,
        message: prompt,
        sessionId: sourceSessionId,
        sessionKey: proofSessionKey,
      });
      await expect
        .poll(() =>
          historyGate.observedGatewayResponses.some(
            (response) => response.requestId === rejectedSend.requestId,
          ),
        )
        .toBe(true);
      const rejectedResponse = historyGate.observedGatewayResponses.find(
        (response) => response.requestId === rejectedSend.requestId,
      )!;
      expect(rejectedResponse.ok).toBe(false);
      const rejectedError = requireRecord(rejectedResponse.error, "rejected chat.send error");
      const rejectedDetails = requireRecord(rejectedError.details, "rejected chat.send details");
      expect(rejectedError.code).toBe("INVALID_REQUEST");
      expect(rejectedDetails.reason).toBe("active-leaf-changed");

      await expect.poll(() => historyGate.state.historyHeld).toBe(true);
      await queue.getByText("Failed", { exact: true }).waitFor();
      await queue.getByText("The thread switched branches — review and resend.").waitFor();
      expect(historyGate.state).toMatchObject({
        historyHeld: true,
        historyReleased: false,
        historyResponseArrived: true,
        postRejectionHistoryRequests: 1,
        rejectedSendObserved: true,
        rejectedSendRequestId: rejectedSend.requestId,
      });
      expect(historyGate.state.heldHistoryRequestIds).toHaveLength(1);
      expect(historyGate.state.heldHistoryResponse).toMatchObject({
        activeLeafEntryId: switchedLeaf,
        ok: true,
        sessionId: switchedSessionId,
      });
      const heldHistoryRequest = historyGate.observedGatewayRequests.find(
        (request) => request.requestId === historyGate.state.heldHistoryRequestIds[0],
      );
      expect(heldHistoryRequest).toMatchObject({
        method: "chat.history",
        params: { limit: 100, sessionKey: proofSessionKey },
      });
      const heldHistoryRequestIndex = historyGate.observedGatewayRequests.findIndex(
        (request) => request.requestId === heldHistoryRequest?.requestId,
      );
      expect(heldHistoryRequestIndex).toBeGreaterThanOrEqual(0);
      expect(modelServer.requests).toHaveLength(providerRequestsAtStart + 1);
      const providerRequestsAtRejection = modelServer.requests.length;
      const rejectedProviderRequestDelta =
        providerRequestsAtRejection - (providerRequestsAtStart + 1);
      expect(rejectedProviderRequestDelta).toBe(0);
      recordMilestone("cross-branch-rejected-history-held");
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "02-branch-rejected-history-held.png"),
      });

      const retryButton = queue
        .locator(".chat-queue__item", { hasText: prompt })
        .locator(".chat-queue__retry");
      const chatSendsBeforeHeldRetry = historyGate.observedChatSends.length;
      await retryButton.click();
      retryClicks += 1;
      await page.waitForTimeout(750);
      expect(retryClicks).toBe(1);
      expect(historyGate.observedChatSends).toHaveLength(2);
      expect(historyGate.state.postRejectionHistoryRequests).toBe(1);
      expect(historyGate.state.historyReleased).toBe(false);
      expect(modelServer.requests).toHaveLength(providerRequestsAtStart + 1);
      const storedWhileHeld = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "failed row while retry waits for held history",
      );
      expect(storedWhileHeld.sendState).toBe("failed");
      expect(storedWhileHeld.transcriptRevision).toEqual({
        expectedLeafEntryId: queuedSourceLeaf,
        sessionId: sourceSessionId,
      });
      const heldRetryChatSendDelta =
        historyGate.observedChatSends.length - chatSendsBeforeHeldRetry;
      const heldRetryProviderRequestDelta =
        modelServer.requests.length - providerRequestsAtRejection;
      expect(heldRetryChatSendDelta).toBe(0);
      expect(heldRetryProviderRequestDelta).toBe(0);
      recordMilestone("single-retry-blocked-while-held");
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "03-single-retry-blocked-while-history-held.png"),
      });

      const controllerHistory = requireRecord(
        await controller!.request("chat.history", { limit: 100, sessionKey: proofSessionKey }),
        "controller switched history",
      );
      expect(controllerHistory.sessionId).toBe(switchedSessionId);
      expect(requireRecord(controllerHistory.sessionInfo).activeLeafEntryId).toBe(switchedLeaf);

      historyGate.release();
      recordMilestone("held-history-released");
      await expect.poll(() => historyGate.observedChatSends.length).toBe(3);
      const retrySends = historyGate.observedChatSends.slice(2);
      expect(retrySends).toHaveLength(1);
      const retrySend = retrySends[0]!;
      expect(retrySend).toMatchObject({
        expectedLeafEntryId: switchedLeaf,
        message: prompt,
        sessionId: switchedSessionId,
        sessionKey: proofSessionKey,
      });
      const authoritativeDrainRequest = historyGate.observedGatewayRequests.find(
        (request, index) =>
          index > heldHistoryRequestIndex &&
          request.method === "chat.history" &&
          request.params.limit === 1000,
      );
      expect(authoritativeDrainRequest).toBeDefined();
      const authoritativeDrainRequestIndex = historyGate.observedGatewayRequests.findIndex(
        (request) => request.requestId === authoritativeDrainRequest?.requestId,
      );
      const retrySendRequestIndex = historyGate.observedGatewayRequests.findIndex(
        (request) => request.requestId === retrySend.requestId,
      );
      expect(authoritativeDrainRequestIndex).toBeGreaterThan(heldHistoryRequestIndex);
      expect(retrySendRequestIndex).toBeGreaterThan(authoritativeDrainRequestIndex);
      const authoritativeDrainResponse = historyGate.observedGatewayResponses.find(
        (response) => response.requestId === authoritativeDrainRequest?.requestId,
      );
      expect(authoritativeDrainResponse).toMatchObject({
        ok: true,
        requestId: authoritativeDrainRequest?.requestId,
        requestMethod: "chat.history",
      });
      recordMilestone("single-refreshed-retry-sent");
      await expect
        .poll(() =>
          historyGate.observedGatewayResponses.some(
            (response) => response.requestId === retrySend.requestId,
          ),
        )
        .toBe(true);
      const retryResponse = historyGate.observedGatewayResponses.find(
        (response) => response.requestId === retrySend.requestId,
      )!;
      expect(retryResponse.ok).toBe(true);
      const retryPayload = requireRecord(retryResponse.payload, "accepted retry payload");
      expect(retryPayload.status).toBe("started");
      expect(requireNonEmptyString(retryPayload.runId, "accepted retry run ID")).toBe(
        retrySend.idempotencyKey,
      );

      await expect.poll(() => modelServer.requests.length).toBe(providerRequestsAtStart + 2);
      expect(JSON.stringify(modelServer.requests.at(-1)?.body)).toContain(prompt);
      recordMilestone("gateway-accepted-retry");
      await waitForUniqueChatLogText(page, reply);
      await expect.poll(async () => await readPersistedQueueItem(page, prompt)).toBeNull();

      let terminalHistory: Record<string, unknown> | undefined;
      await expect
        .poll(async () => {
          const history = requireRecord(
            await controller!.request("chat.history", {
              limit: 100,
              sessionKey: proofSessionKey,
            }),
            "terminal retry history",
          );
          const activeRunIds = requireStringArray(
            requireRecord(history.sessionInfo, "terminal history sessionInfo").activeRunIds,
            "terminal active run IDs",
          );
          if (activeRunIds.length !== 0 || !JSON.stringify(history.messages).includes(reply)) {
            return false;
          }
          terminalHistory = history;
          return true;
        })
        .toBe(true);
      await page.waitForTimeout(750);
      expect(historyGate.observedChatSends).toHaveLength(3);
      expect(modelServer.requests).toHaveLength(providerRequestsAtStart + 2);
      expect(historyGate.state.historyReleased).toBe(true);
      recordMilestone("final-visible-row-retired");
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "04-single-refreshed-retry-accepted.png"),
      });

      const finalHistory = requireRecord(terminalHistory, "final terminal history");
      const finalSessionInfo = requireRecord(finalHistory.sessionInfo, "final sessionInfo");
      expect(finalHistory.sessionId).toBe(switchedSessionId);
      const screenshots = await collectScreenshotEvidence();
      const nativeWebSocketTrace = {
        mergeBaseSha: candidateBaseSha,
        dataClassification: "synthetic-redacted",
        evidenceTipSha,
        gatewayMode: "real-ephemeral-process",
        headSha: candidateHeadSha,
        historyGate: historyGate.state,
        mockGateway: false,
        operatorTimeline,
        providerBoundary: "synthetic-local-http",
        samePathPrecondition: {
          authoritativeActiveLeafEntryId: samePathAuthoritativeSessionInfo.activeLeafEntryId,
          authoritativeActiveRunIds: samePathAuthoritativeSessionInfo.activeRunIds,
          browserDisplayedLeafEntryId: samePathBrowserRevisionBeforeSend.displayedLeafEntryId,
          sessionId: samePathAuthoritativeHistory.sessionId,
        },
        scenario: "branch-rejection-held-refresh-single-retry",
        screenshots,
        sequence: historyGate.trace,
        terminalBarrier: {
          activeLeafEntryId: finalSessionInfo.activeLeafEntryId,
          activeRunIds: finalSessionInfo.activeRunIds,
          observedVia: "controller-chat.history",
          sessionId: finalHistory.sessionId,
        },
        transport: "real-browser-native-websocket-via-playwright-connectToServer",
      };
      const serializedTrace = `${JSON.stringify(nativeWebSocketTrace, null, 2)}\n`;
      assertRedactedEvidence(serializedTrace);
      await writeFile(
        path.join(artifactDir, "01-branch-rejection-single-retry-native-ws-trace.json"),
        serializedTrace,
      );

      proof.branchRejectionSingleRetry = {
        continuousScenario: true,
        authoritativeDrainHistoryRequestId: authoritativeDrainRequest?.requestId,
        authoritativeDrainHistoryResponseOk: authoritativeDrainResponse?.ok === true,
        failedRowRetired: true,
        gatewayAcceptedRetry: retryResponse.ok === true,
        gatewayRejectionCode: rejectedError.code,
        gatewayRejectionReason: rejectedDetails.reason,
        heldHistoryActiveLeafEntryId: historyGate.state.heldHistoryResponse?.activeLeafEntryId,
        heldHistoryResponseArrived: historyGate.state.historyResponseArrived,
        heldHistoryResponseBlockedBeforeBrowserDelivery: true,
        heldHistoryRequestId: heldHistoryRequest?.requestId,
        heldHistorySessionId: historyGate.state.heldHistoryResponse?.sessionId,
        historyReleased: historyGate.state.historyReleased,
        initialExpectedLeafEntryId: rejectedSend.expectedLeafEntryId,
        initialSessionId: rejectedSend.sessionId,
        noSecondChatSendWhileHeld: true,
        offlineQueue: {
          expectedLeafEntryId: storedAfterReloadRevision.expectedLeafEntryId,
          sessionId: storedAfterReloadRevision.sessionId,
          status: "pass",
          survivedReload: true,
        },
        providerRequestDelta: modelServer.requests.length - (providerRequestsAtStart + 1),
        rejection: {
          code: rejectedError.code,
          failedRowObserved: true,
          providerRequestDelta: rejectedProviderRequestDelta,
          reason: rejectedDetails.reason,
          requestId: rejectedSend.requestId,
          status: "pass",
        },
        retryClicks,
        retryExpectedLeafEntryId: retrySend.expectedLeafEntryId,
        retryRequestId: retrySend.requestId,
        retryRequestCount: retrySends.length,
        retryRunId: retryPayload.runId,
        retrySessionId: retrySend.sessionId,
        status: "pass",
        rejectedRequestId: rejectedSend.requestId,
        switchedLeaf,
        switchedSessionId,
        branchSwitch: {
          sourceSessionId,
          status: "pass",
          switchedLeaf,
          switchedSessionId,
        },
        heldRetry: {
          chatSendDelta: heldRetryChatSendDelta,
          clickCount: retryClicks,
          failedRowPersisted: storedWhileHeld.sendState === "failed",
          providerRequestDelta: heldRetryProviderRequestDelta,
          status: "pass",
        },
        samePathAcceptance: {
          expectedLeafEntryId: samePathSend.expectedLeafEntryId,
          gatewayAccepted: true,
          providerRequestDelta: 1,
          queuedSourceLeaf,
          renderedLeaf,
          requestId: samePathSend.requestId,
          authoritativeActiveLeafEntryIdBeforeSend:
            samePathAuthoritativeSessionInfo.activeLeafEntryId,
          authoritativeActiveRunIdsBeforeSend: samePathAuthoritativeSessionInfo.activeRunIds,
          browserDisplayedLeafEntryIdBeforeSend:
            samePathBrowserRevisionBeforeSend.displayedLeafEntryId,
          status: "pass",
          visibleReply: samePathReply,
        },
        terminalActiveRunIds: finalSessionInfo.activeRunIds,
        terminalSessionId: finalHistory.sessionId,
        visibleReply: reply,
        screenshots,
        operatorTimeline,
      };
    } finally {
      try {
        if (historyGate.state.historyHeld && !historyGate.state.historyReleased) {
          historyGate.release();
        }
      } finally {
        try {
          await context.close();
        } finally {
          if (gatewayStopped) {
            await instance.startGateway();
          }
          if (!controller) {
            controller = await connectController();
          }
        }
      }
    }
  }, 240_000);
});
