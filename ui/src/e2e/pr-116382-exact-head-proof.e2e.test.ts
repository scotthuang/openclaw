// Evidence-branch-only exact-head real-Gateway browser proof for PR #116382.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
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
const postClearRetryPrompt = "restore this queued turn after a real branch rotation";
const postClearRetryReply = "Post-clear retry accepted by the real Gateway.";
const exactRunInitialPrompt = "keep this exact run active while its transcript advances";
const exactRunInitialReply = "The exact target run stayed active.";
const exactRunSteerPrompt = "steer this instruction into the exact active run";
const exactRunSteerReply = "Exact-run steer accepted without successor dispatch.";
const exactRunSlashCommand = `/steer ${exactRunSteerPrompt}`;
const stalePaneRunId = "pr-116382-stale-pane-run";
const storeName = "sessions.json";
const waitTimeoutMs = 60_000;

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
  holdNextResponse: () => () => void;
  requests: ModelRequest[];
  stop: () => Promise<void>;
};
type ObservedGatewayRequest = {
  method: string;
  params: Record<string, unknown>;
  requestId?: unknown;
};
type ObservedChatSend = {
  deliver?: unknown;
  expectedLeafEntryId?: unknown;
  expectedRunId?: unknown;
  idempotencyKey?: unknown;
  message?: unknown;
  queueMode?: unknown;
  requestId?: unknown;
  sessionId?: unknown;
  sessionKey?: unknown;
};

let browser: Browser;
let uiServer: ControlUiE2eServer;
let instance: OpenClawTestInstance;
let modelServer: SyntheticModelServer;
let controller: GatewayClient | undefined;
const proof: Record<string, unknown> = {
  baseSha: candidateBaseSha,
  dataClassification: "synthetic-redacted",
  evidenceTipSha,
  gatewayMode: "real-ephemeral-process",
  headSha: candidateHeadSha,
  mockGateway: false,
  proofSessionKey,
  providerBoundary: "synthetic-local-http",
  startedAt: new Date().toISOString(),
  status: "running",
  websocket: "real-browser-native",
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
  let nextResponseHold: { promise: Promise<void>; release: () => void } | undefined;
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
      const responseHold = nextResponseHold;
      nextResponseHold = undefined;
      await responseHold?.promise;
      const serializedBody = JSON.stringify(body);
      const reply = serializedBody.includes(exactRunSteerPrompt)
        ? exactRunSteerReply
        : serializedBody.includes(exactRunInitialPrompt)
          ? exactRunInitialReply
          : serializedBody.includes(postClearRetryPrompt)
            ? postClearRetryReply
            : "Same-branch send accepted by the real Gateway.";
      writeResponsesReply(res, reply, requests.length);
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
    holdNextResponse: () => {
      if (nextResponseHold) {
        throw new Error("a synthetic provider response is already held");
      }
      let resolveHold!: () => void;
      let released = false;
      const hold = {
        promise: new Promise<void>((resolve) => {
          resolveHold = resolve;
        }),
        release: () => {
          if (released) {
            return;
          }
          released = true;
          if (nextResponseHold === hold) {
            nextResponseHold = undefined;
          }
          resolveHold();
        },
      };
      nextResponseHold = hold;
      return hold.release;
    },
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
    timeoutMs: 30_000,
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

async function closeContextWithVideo(
  context: BrowserContext,
  page: Page,
  targetName: string,
): Promise<void> {
  const video = page.video();
  await context.close();
  const source = await video?.path().catch(() => undefined);
  if (source) {
    await copyFile(source, path.join(artifactDir, targetName));
  }
}

async function createRealGatewayPage(): Promise<{
  context: BrowserContext;
  observedAgentEvents: Record<string, unknown>[];
  observedChatEvents: Record<string, unknown>[];
  observedChatResponses: Record<string, unknown>[];
  observedChatSends: ObservedChatSend[];
  observedGatewayRequests: ObservedGatewayRequest[];
  observedGatewayResponses: Record<string, unknown>[];
  page: Page;
}> {
  const context = await browser.newContext({
    locale: "en-US",
    recordVideo: {
      dir: path.join(artifactDir, "raw-video"),
      size: { height: 900, width: 1280 },
    },
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  await context.addInitScript(
    ({ gatewayUrl, token }) => {
      (
        window as Window & {
          __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
    },
    { gatewayUrl: instance.url, token: instance.gatewayToken },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(waitTimeoutMs);
  const observedAgentEvents: Record<string, unknown>[] = [];
  const observedChatEvents: Record<string, unknown>[] = [];
  const observedChatResponses: Record<string, unknown>[] = [];
  const observedChatSends: ObservedChatSend[] = [];
  const observedGatewayRequests: ObservedGatewayRequest[] = [];
  const observedGatewayResponses: Record<string, unknown>[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const frame = requireRecord(JSON.parse(String(payload)), "WebSocket frame");
        if (
          frame.type === "req" &&
          (frame.method === "chat.send" ||
            frame.method === "chat.history" ||
            frame.method === "sessions.reset")
        ) {
          const method = String(frame.method);
          const params = requireRecord(frame.params, `${method} params`);
          observedGatewayRequests.push({ method, params, requestId: frame.id });
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = requireRecord(frame.params, "chat.send params");
          observedChatSends.push({
            deliver: params.deliver,
            expectedLeafEntryId: params.expectedLeafEntryId,
            expectedRunId: params.expectedRunId,
            idempotencyKey: params.idempotencyKey,
            message: params.message,
            queueMode: params.queueMode,
            requestId: frame.id,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          });
        }
      } catch {
        // Binary and non-JSON frames are irrelevant to this focused transport proof.
      }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = requireRecord(JSON.parse(String(payload)), "WebSocket response frame");
        if (frame.type === "event" && frame.event === "agent") {
          observedAgentEvents.push(requireRecord(frame.payload, "agent event payload"));
        }
        if (frame.type === "event" && frame.event === "chat") {
          observedChatEvents.push(requireRecord(frame.payload, "chat event payload"));
        }
        if (
          frame.type === "res" &&
          observedGatewayRequests.some((request) => request.requestId === frame.id)
        ) {
          observedGatewayResponses.push(frame);
        }
        if (
          frame.type === "res" &&
          observedChatSends.some((request) => request.requestId === frame.id)
        ) {
          observedChatResponses.push(frame);
        }
      } catch {
        // Binary and non-JSON frames are irrelevant to this focused transport proof.
      }
    });
  });
  return {
    context,
    observedAgentEvents,
    observedChatEvents,
    observedChatResponses,
    observedChatSends,
    observedGatewayRequests,
    observedGatewayResponses,
    page,
  };
}

type BrowserPostRejectionHistoryHold = {
  historyHeld: boolean;
  historyReleased: boolean;
  postRejectionHistoryRequests: number;
  rejectedSendObserved: boolean;
};

async function armBrowserPostRejectionHistoryHold(page: Page): Promise<void> {
  await page.evaluate(() => {
    type BrowserClient = {
      request: (method: string, params?: unknown, options?: unknown) => Promise<unknown>;
    };
    type HoldWindow = Window & {
      pr116382PostRejectionHistoryHold?: {
        release: () => void;
        state: BrowserPostRejectionHistoryHold;
      };
    };
    const proofWindow = window as HoldWindow;
    if (proofWindow.pr116382PostRejectionHistoryHold) {
      throw new Error("post-rejection history hold is already armed");
    }
    const pane = document.querySelector("openclaw-chat-pane") as HTMLElement & {
      state?: { client?: BrowserClient | null };
    };
    const client = pane?.state?.client;
    if (!client || typeof client.request !== "function") {
      throw new Error("browser chat pane Gateway client is unavailable");
    }
    const holdState: BrowserPostRejectionHistoryHold = {
      historyHeld: false,
      historyReleased: false,
      postRejectionHistoryRequests: 0,
      rejectedSendObserved: false,
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const originalRequest = client.request.bind(client);
    client.request = async (method, params, options) => {
      const historyStartedAfterRejection =
        method === "chat.history" && holdState.rejectedSendObserved;
      if (historyStartedAfterRejection) {
        holdState.postRejectionHistoryRequests += 1;
      }
      try {
        const result = await originalRequest(method, params, options);
        if (historyStartedAfterRejection && !holdState.historyHeld) {
          // The real Gateway response has arrived. Delay only its UI application so
          // an immediate Retry deterministically overlaps the rejection refresh.
          holdState.historyHeld = true;
          await gate;
          holdState.historyReleased = true;
        }
        return result;
      } catch (error) {
        if (method === "chat.send") {
          holdState.rejectedSendObserved = true;
        }
        throw error;
      }
    };
    proofWindow.pr116382PostRejectionHistoryHold = {
      release: () => releaseGate(),
      state: holdState,
    };
  });
}

async function readBrowserPostRejectionHistoryHold(
  page: Page,
): Promise<BrowserPostRejectionHistoryHold> {
  return await page.evaluate(() => {
    const value = (
      window as Window & {
        pr116382PostRejectionHistoryHold?: {
          state: BrowserPostRejectionHistoryHold;
        };
      }
    ).pr116382PostRejectionHistoryHold?.state;
    if (!value) {
      throw new Error("post-rejection history hold is not armed");
    }
    return { ...value };
  });
}

async function releaseBrowserPostRejectionHistoryHold(page: Page): Promise<void> {
  await page.evaluate(() => {
    const value = (
      window as Window & {
        pr116382PostRejectionHistoryHold?: { release: () => void };
      }
    ).pr116382PostRejectionHistoryHold;
    if (!value) {
      throw new Error("post-rejection history hold is not armed");
    }
    value.release();
  });
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

async function readBrowserSteerState(page: Page) {
  return await page.evaluate(
    ({ commandText, sessionKey }) => {
      const pane = document.querySelector("openclaw-chat-pane") as HTMLElement & {
        state?: {
          chatQueue?: Array<Record<string, unknown>>;
          chatDisplayedLeafEntryId?: unknown;
          chatLoading?: unknown;
          chatRunId?: unknown;
          sessionsResult?: { sessions?: Array<Record<string, unknown>> } | null;
        };
      };
      const state = pane?.state;
      const session = state?.sessionsResult?.sessions?.find((row) => row.key === sessionKey);
      const pending = state?.chatQueue?.find((item) => item.text === commandText);
      return {
        activeLeafEntryId: session?.activeLeafEntryId,
        activeRunIds: session?.activeRunIds,
        displayedLeafEntryId: state?.chatDisplayedLeafEntryId,
        chatLoading: state?.chatLoading,
        chatRunId: state?.chatRunId,
        pending:
          pending === undefined
            ? null
            : {
                kind: pending.kind,
                pendingRunId: pending.pendingRunId,
                steerTargetRunId: pending.steerTargetRunId,
                text: pending.text,
              },
      };
    },
    { commandText: exactRunSlashCommand, sessionKey: proofSessionKey },
  );
}

async function refreshBrowserSteerState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pane = document.querySelector("openclaw-chat-pane") as HTMLElement & {
      state?: { refreshCurrentChat?: () => Promise<void> };
    };
    const refreshCurrentChat = pane?.state?.refreshCurrentChat;
    if (typeof refreshCurrentChat !== "function") {
      throw new Error("browser chat pane refresh is unavailable");
    }
    await refreshCurrentChat();
  });
}

async function seedBrowserSteerOwnershipDrift(
  page: Page,
  targetRunId: string,
  staleLeafEntryId: string,
  expectedDisplayedLeafEntryId: string,
) {
  return await page.evaluate(
    ({ expectedDisplayedLeaf, expectedTargetRunId, sessionKey, staleLeaf, staleRun }) => {
      const pane = document.querySelector("openclaw-chat-pane") as HTMLElement & {
        state?: {
          chatDisplayedLeafEntryId?: unknown;
          chatRunId?: unknown;
          requestUpdate?: () => void;
          sessionsResult?: { sessions?: Array<Record<string, unknown>> } | null;
        };
      };
      const state = pane?.state;
      const sessionsResult = state?.sessionsResult;
      const sessions = sessionsResult?.sessions;
      if (!state || !sessionsResult || !Array.isArray(sessions)) {
        throw new Error("browser chat pane session state is unavailable");
      }
      const target = sessions.find((row) => row.key === sessionKey);
      if (
        !target ||
        !Array.isArray(target.activeRunIds) ||
        !target.activeRunIds.includes(expectedTargetRunId)
      ) {
        throw new Error("browser session row does not own the exact target run");
      }
      if (state.chatDisplayedLeafEntryId !== expectedDisplayedLeaf) {
        throw new Error("browser pane has not rendered the authoritative active leaf");
      }
      const activeLeafEntryIdBeforeDrift = target.activeLeafEntryId;
      const displayedLeafEntryIdBeforeDrift = state.chatDisplayedLeafEntryId;
      const paneRunIdBeforeDrift = state.chatRunId;
      state.sessionsResult = {
        ...sessionsResult,
        sessions: sessions.map((row) =>
          row === target ? Object.assign({}, row, { activeLeafEntryId: staleLeaf }) : row,
        ),
      };
      state.chatRunId = staleRun;
      state.requestUpdate?.();
      return {
        activeLeafEntryIdBeforeDrift,
        activeLeafEntryIdAfterDrift: staleLeaf,
        displayedLeafEntryIdAfterDrift: state.chatDisplayedLeafEntryId,
        displayedLeafEntryIdBeforeDrift,
        paneRunIdBeforeDrift,
        paneRunIdAfterDrift: state.chatRunId,
        seededByProof: true,
        targetRunId: expectedTargetRunId,
      };
    },
    {
      expectedDisplayedLeaf: expectedDisplayedLeafEntryId,
      expectedTargetRunId: targetRunId,
      sessionKey: proofSessionKey,
      staleLeaf: staleLeafEntryId,
      staleRun: stalePaneRunId,
    },
  );
}

async function readPersistedQueueItem(page: Page, prompt: string) {
  return await page.evaluate((expectedPrompt) => {
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
          .find((candidate) => candidate.text === expectedPrompt);
        if (item) {
          return item;
        }
      } catch {
        // Ignore unrelated malformed browser storage in this focused proof.
      }
    }
    return null;
  }, prompt);
}

describeProof("PR #116382 exact-head real Gateway Control UI proof", () => {
  beforeAll(async () => {
    await mkdir(path.join(artifactDir, "raw-video"), { recursive: true });
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
        ui: { prefs: { chatFollowUpMode: "steer" } },
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
    await closeController();
    await browser?.close().catch(() => undefined);
    await instance?.cleanup().catch(() => undefined);
    await modelServer?.stop().catch(() => undefined);
    await uiServer?.close().catch(() => undefined);
    proof.finishedAt = new Date().toISOString();
    proof.status =
      proof.sameBranchBackgroundAppend &&
      proof.restoredQueuedBranchSwitch &&
      proof.resetBoundaryGuardedRetry &&
      proof.exactRunSteerSameRun
        ? "pass"
        : "incomplete";
    await writeFile(path.join(artifactDir, "gateway.log"), instance?.logs() ?? "");
    await writeFile(
      path.join(artifactDir, "pr-116382-exact-head-proof.json"),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
  });

  it("accepts an ancestor revision after a canonical same-branch append", async () => {
    const sessionId = "pr-116382-same-branch-generation";
    const renderedLeaf = "pr-116382-rendered-leaf";
    const backgroundLeaf = "pr-116382-background-leaf";
    const prompt = "send after canonical same-branch background progress";
    const reply = "Same-branch send accepted by the real Gateway.";
    await seedSession({
      sessionId,
      events: [
        {
          content: "The rendered branch is ready.",
          eventId: renderedLeaf,
          parentId: null,
        },
      ],
    });
    const { context, observedChatSends, page } = await createRealGatewayPage();

    try {
      await page.goto(`${uiServer.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
      await page.getByText("The rendered branch is ready.", { exact: true }).waitFor();
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionId,
          sessionKey: proofSessionKey,
          storePath: sessionStorePath(),
        },
        {
          eventId: backgroundLeaf,
          message: { content: "Background progress landed on the same branch.", role: "assistant" },
          now: Date.now(),
          parentId: renderedLeaf,
        },
      );
      const backgroundHistory = requireRecord(
        await controller!.request("chat.history", { limit: 100, sessionKey: proofSessionKey }),
        "background history",
      );
      expect(backgroundHistory.sessionId).toBe(sessionId);
      expect(requireRecord(backgroundHistory.sessionInfo).activeLeafEntryId).toBe(backgroundLeaf);

      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => observedChatSends.length).toBe(1);
      const sent = observedChatSends[0]!;
      expect(sent).toMatchObject({
        expectedLeafEntryId: renderedLeaf,
        message: prompt,
        sessionId,
      });
      await page.getByText(reply, { exact: true }).waitFor({ timeout: waitTimeoutMs });
      await expect.poll(() => modelServer.requests.length).toBe(1);
      expect(JSON.stringify(modelServer.requests[0]?.body)).toContain(prompt);
      const acceptedHistory = requireRecord(
        await controller!.request("chat.history", { limit: 100, sessionKey: proofSessionKey }),
        "accepted history",
      );
      expect(acceptedHistory.sessionId).toBe(sessionId);
      expect(JSON.stringify(acceptedHistory.messages)).toContain("Background progress landed");
      expect(JSON.stringify(acceptedHistory.messages)).toContain(prompt);
      expect(JSON.stringify(acceptedHistory.messages)).toContain(reply);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "01-same-branch-send-accepted.png"),
      });
      proof.sameBranchBackgroundAppend = {
        acceptedByRealGateway: true,
        backgroundLeafEntryId: backgroundLeaf,
        expectedLeafEntryIdSent: sent.expectedLeafEntryId,
        providerRequests: modelServer.requests.length,
        requestSessionId: sent.sessionId,
        status: "pass",
      };
    } finally {
      await closeContextWithVideo(context, page, "01-same-branch-send-accepted.webm");
    }
  }, 120_000);

  it("parks a restored queued send and rebinds its retry to the reset boundary", async () => {
    const sourceSessionId = "pr-116382-generation-before-switch";
    const rootLeaf = "pr-116382-rotation-root";
    const switchedLeaf = "pr-116382-rotation-alternate";
    const renderedLeaf = "pr-116382-rotation-rendered";
    const prompt = postClearRetryPrompt;
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
    const {
      context,
      observedChatResponses,
      observedChatSends,
      observedGatewayRequests,
      observedGatewayResponses,
      page,
    } = await createRealGatewayPage();
    let browserHistoryHoldArmed = false;
    let releaseHeldResponse: (() => void) | undefined;

    try {
      await page.goto(`${uiServer.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
      await page
        .locator(".chat-thread-inner .chat-text", {
          hasText: "Queue this turn before switching branches.",
        })
        .waitFor();
      await closeController();
      await instance.stopGateway();
      await waitForGatewayPhase(page, "reconnecting");
      await page.locator(".agent-chat__offline-hint").waitFor({ timeout: 15_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const queue = page.locator(".chat-queue");
      await queue.getByText("Waiting for reconnect").waitFor();
      await queue.getByText(prompt, { exact: true }).waitFor();
      const storedBeforeReload = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored queue before reload",
      );
      expect(storedBeforeReload.transcriptRevision).toEqual({
        expectedLeafEntryId: renderedLeaf,
        sessionId: sourceSessionId,
      });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "02-queued-before-branch-switch.png"),
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
        "stored queue after reload",
      );
      expect(storedAfterReload.transcriptRevision).toEqual({
        expectedLeafEntryId: renderedLeaf,
        sessionId: sourceSessionId,
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const pane = document.querySelector("openclaw-chat-pane") as HTMLElement & {
              state?: { client?: unknown };
            };
            return Boolean(pane?.state?.client);
          }),
        )
        .toBe(true);
      await armBrowserPostRejectionHistoryHold(page);
      browserHistoryHoldArmed = true;
      const providerRequestsBeforeRejectedDrain = modelServer.requests.length;
      expect(providerRequestsBeforeRejectedDrain).toBe(1);
      await instance.startGateway();
      controller = await connectController();
      await waitForGatewayPhase(page, "connected");
      await page
        .locator(".chat-thread-inner .chat-text", {
          hasText: "A different branch will become authoritative.",
        })
        .waitFor();
      await expect.poll(() => observedChatSends.length).toBe(1);
      const restoredSend = observedChatSends[0]!;
      expect(restoredSend).toMatchObject({
        expectedLeafEntryId: renderedLeaf,
        message: prompt,
        sessionId: sourceSessionId,
      });
      await expect.poll(() => observedChatResponses.length).toBe(1);
      const gatewayResponse = observedChatResponses[0]!;
      expect(gatewayResponse).toMatchObject({
        id: restoredSend.requestId,
        ok: false,
        type: "res",
      });
      const gatewayError = requireRecord(gatewayResponse.error, "chat.send Gateway error");
      const gatewayErrorDetails = requireRecord(
        gatewayError.details,
        "chat.send Gateway error details",
      );
      expect(gatewayError.code).toBe("INVALID_REQUEST");
      expect(gatewayErrorDetails.reason).toBe("active-leaf-changed");
      await queue.getByText("Failed", { exact: true }).waitFor();
      await queue.getByText("The thread switched branches — review and resend.").waitFor();
      const storedAfterRejection = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored queue after rejection",
      );
      expect(storedAfterRejection.sendState).toBe("failed");
      expect(storedAfterRejection.transcriptRevision).toEqual({
        expectedLeafEntryId: renderedLeaf,
        sessionId: sourceSessionId,
      });
      const providerRequestsAfterRejectedDrain = modelServer.requests.length;
      expect(providerRequestsAfterRejectedDrain).toBe(1);
      await expect
        .poll(async () => (await readBrowserPostRejectionHistoryHold(page)).historyHeld)
        .toBe(true);
      const historyHoldBeforeImmediateRetry = await readBrowserPostRejectionHistoryHold(page);
      expect(historyHoldBeforeImmediateRetry).toMatchObject({
        historyHeld: true,
        historyReleased: false,
        postRejectionHistoryRequests: 1,
        rejectedSendObserved: true,
      });
      const restoredSendRequestIndex = observedGatewayRequests.findIndex(
        (request) => request.requestId === restoredSend.requestId,
      );
      expect(restoredSendRequestIndex).toBeGreaterThanOrEqual(0);
      const postRejectionHistoryRequest = observedGatewayRequests
        .slice(restoredSendRequestIndex + 1)
        .find((request) => request.method === "chat.history");
      expect(postRejectionHistoryRequest).toBeDefined();
      await expect
        .poll(() =>
          observedGatewayResponses.some(
            (response) => response.id === postRejectionHistoryRequest?.requestId,
          ),
        )
        .toBe(true);
      const postRejectionHistoryResponse = observedGatewayResponses.find(
        (response) => response.id === postRejectionHistoryRequest?.requestId,
      )!;
      expect(postRejectionHistoryResponse).toMatchObject({ ok: true, type: "res" });

      const retryButton = queue
        .locator(".chat-queue__item", { hasText: prompt })
        .locator(".chat-queue__retry");
      const chatSendsBeforeImmediateRetry = observedChatSends.length;
      await retryButton.click();
      await page.waitForTimeout(250);
      const chatSendsWhileImmediateRetryBlocked = observedChatSends.length;
      expect(observedChatSends).toHaveLength(chatSendsBeforeImmediateRetry);
      expect(modelServer.requests).toHaveLength(providerRequestsAfterRejectedDrain);
      const historyHoldWhileImmediateRetryBlocked = await readBrowserPostRejectionHistoryHold(page);
      expect(historyHoldWhileImmediateRetryBlocked).toMatchObject({
        historyHeld: true,
        historyReleased: false,
        postRejectionHistoryRequests: 1,
        rejectedSendObserved: true,
      });
      const storedWhileImmediateRetryBlocked = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored row while immediate retry waits for rejection history",
      );
      expect(storedWhileImmediateRetryBlocked).toMatchObject({ sendState: "failed" });
      expect(storedWhileImmediateRetryBlocked.transcriptRevision).toEqual({
        expectedLeafEntryId: renderedLeaf,
        sessionId: sourceSessionId,
      });
      const switchedHistory = requireRecord(
        await controller.request("chat.history", { limit: 100, sessionKey: proofSessionKey }),
        "switched history",
      );
      expect(switchedHistory.sessionId).toBe(switchedSessionId);
      expect(requireRecord(switchedHistory.sessionInfo).activeLeafEntryId).toBe(switchedLeaf);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "03-restored-cross-branch-needs-review.png"),
      });
      proof.restoredQueuedBranchSwitch = {
        activeLeafAfterSwitch: switchedLeaf,
        activeSessionAfterSwitch: switchedSessionId,
        expectedLeafEntryIdSent: restoredSend.expectedLeafEntryId,
        gatewayResponseCode: gatewayError.code,
        gatewayResponseReason: gatewayErrorDetails.reason,
        parkedState: storedAfterRejection.sendState,
        providerRequestsAfterRejectedDrain,
        providerRequestsBeforeRejectedDrain,
        requestSessionId: restoredSend.sessionId,
        status: "pass",
        visibleError: "The thread switched branches — review and resend.",
      };

      const preResetSqliteEntry = loadSessionEntry({
        sessionKey: proofSessionKey,
        storePath: sessionStorePath(),
      });
      expect(preResetSqliteEntry?.sessionId).toBe(switchedSessionId);
      const preResetLifecycleRevision = preResetSqliteEntry?.lifecycleRevision;
      if (typeof preResetLifecycleRevision !== "string" || !preResetLifecycleRevision.trim()) {
        throw new Error("pre-reset SQLite entry must expose a lifecycle revision");
      }
      const transcriptScope = {
        agentId: "main",
        sessionId: switchedSessionId,
        sessionKey: proofSessionKey,
        storePath: sessionStorePath(),
      };
      const preResetTranscriptEvents = await loadTranscriptEvents(transcriptScope);

      const resetRequestsBeforeClear = observedGatewayRequests.filter(
        (request) => request.method === "sessions.reset",
      ).length;
      const historyRequestsBeforeClear = observedGatewayRequests.filter(
        (request) => request.method === "chat.history",
      ).length;
      await page.locator(".agent-chat__composer-combobox textarea").fill("/clear");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect
        .poll(
          () =>
            observedGatewayRequests.filter((request) => request.method === "sessions.reset").length,
        )
        .toBe(resetRequestsBeforeClear + 1);
      const resetRequest = observedGatewayRequests.findLast(
        (request) => request.method === "sessions.reset",
      )!;
      expect(resetRequest.params).toMatchObject({ key: proofSessionKey });
      await expect
        .poll(() =>
          observedGatewayResponses.some((response) => response.id === resetRequest.requestId),
        )
        .toBe(true);
      const resetResponse = observedGatewayResponses.find(
        (response) => response.id === resetRequest.requestId,
      )!;
      expect(resetResponse).toMatchObject({ ok: true, type: "res" });
      const resetResponsePayload = requireRecord(
        resetResponse.payload,
        "browser sessions.reset response payload",
      );
      const resetResponseEntry = requireRecord(
        resetResponsePayload.entry,
        "browser sessions.reset response entry",
      );
      expect(resetResponsePayload.key).toBe(proofSessionKey);
      const postResetSessionId = resetResponseEntry.sessionId;
      if (typeof postResetSessionId !== "string" || !postResetSessionId.trim()) {
        throw new Error("sessions.reset response must expose the retained session ID");
      }
      expect(postResetSessionId).toBe(switchedSessionId);
      const postResetLifecycleRevision = resetResponseEntry.lifecycleRevision;
      if (typeof postResetLifecycleRevision !== "string" || !postResetLifecycleRevision.trim()) {
        throw new Error("sessions.reset response must expose the new lifecycle revision");
      }
      expect(postResetLifecycleRevision).not.toBe(preResetLifecycleRevision);
      const postResetSqliteEntry = loadSessionEntry({
        sessionKey: proofSessionKey,
        storePath: sessionStorePath(),
      });
      expect(postResetSqliteEntry?.sessionId).toBe(postResetSessionId);
      expect(postResetSqliteEntry?.lifecycleRevision).toBe(postResetLifecycleRevision);
      const postResetTranscriptEvents = await loadTranscriptEvents(transcriptScope);
      expect(postResetTranscriptEvents.slice(0, preResetTranscriptEvents.length)).toEqual(
        preResetTranscriptEvents,
      );
      const appendedResetEvents = postResetTranscriptEvents.slice(preResetTranscriptEvents.length);
      expect(appendedResetEvents).toHaveLength(1);
      const resetBoundary = requireRecord(appendedResetEvents[0], "SQLite reset boundary");
      expect(resetBoundary).toMatchObject({
        parentId: switchedLeaf,
        reason: "reset",
        type: "reset",
      });
      const resetBoundaryHasFirstKeptEntryId = Object.hasOwn(resetBoundary, "firstKeptEntryId");
      expect(resetBoundaryHasFirstKeptEntryId).toBe(false);
      const resetBoundaryEntryId = resetBoundary.id;
      if (typeof resetBoundaryEntryId !== "string" || !resetBoundaryEntryId.trim()) {
        throw new Error("SQLite reset boundary must expose a nonempty entry ID");
      }
      expect(resetBoundaryEntryId).not.toBe(renderedLeaf);
      expect(resetBoundaryEntryId).not.toBe(switchedLeaf);
      const resetRequestIndex = observedGatewayRequests.indexOf(resetRequest);
      await expect
        .poll(() =>
          observedGatewayRequests
            .slice(resetRequestIndex + 1)
            .some((request) => request.method === "chat.history"),
        )
        .toBe(true);
      const postResetHistoryRequest = observedGatewayRequests
        .slice(resetRequestIndex + 1)
        .find((request) => request.method === "chat.history")!;
      expect(postResetHistoryRequest.params).toMatchObject({ sessionKey: proofSessionKey });
      await expect
        .poll(() =>
          observedGatewayResponses.some(
            (response) => response.id === postResetHistoryRequest.requestId,
          ),
        )
        .toBe(true);
      const postResetHistoryResponse = observedGatewayResponses.find(
        (response) => response.id === postResetHistoryRequest.requestId,
      )!;
      expect(postResetHistoryResponse).toMatchObject({ ok: true, type: "res" });
      const browserPostResetHistory = requireRecord(
        postResetHistoryResponse.payload,
        "browser post-reset history payload",
      );
      const browserPostResetSessionInfo = requireRecord(
        browserPostResetHistory.sessionInfo,
        "browser post-reset session info",
      );
      if (!Array.isArray(browserPostResetHistory.messages)) {
        throw new Error("browser post-reset history must expose a messages array");
      }
      const browserPostResetMessages = browserPostResetHistory.messages;
      const browserPostResetSessionId = browserPostResetHistory.sessionId;
      if (typeof browserPostResetSessionId !== "string" || !browserPostResetSessionId.trim()) {
        throw new Error("browser post-reset history must expose the retained session ID");
      }
      expect(browserPostResetSessionId).toBe(postResetSessionId);
      expect(browserPostResetMessages).toEqual([]);
      expect(Object.hasOwn(browserPostResetSessionInfo, "activeLeafEntryId")).toBe(true);
      expect(browserPostResetSessionInfo.activeLeafEntryId).toBe(resetBoundaryEntryId);
      expect(
        observedGatewayRequests.filter((request) => request.method === "chat.history").length,
      ).toBeGreaterThan(historyRequestsBeforeClear);

      const clearedHistory = requireRecord(
        await controller.request("chat.history", { limit: 100, sessionKey: proofSessionKey }),
        "post-clear history",
      );
      const clearedSessionInfo = requireRecord(
        clearedHistory.sessionInfo,
        "post-clear session info",
      );
      const controllerPostResetSessionId = clearedHistory.sessionId;
      if (
        typeof controllerPostResetSessionId !== "string" ||
        !controllerPostResetSessionId.trim()
      ) {
        throw new Error("controller post-reset history must expose the retained session ID");
      }
      if (!Array.isArray(clearedHistory.messages)) {
        throw new Error("controller post-reset history must expose a messages array");
      }
      expect(clearedHistory.messages).toEqual([]);
      expect(clearedHistory.messages).toEqual(browserPostResetMessages);
      expect(Object.hasOwn(clearedSessionInfo, "activeLeafEntryId")).toBe(true);
      expect(clearedSessionInfo.activeLeafEntryId).toBe(resetBoundaryEntryId);
      expect(controllerPostResetSessionId).toBe(postResetSessionId);
      await queue.getByText("Failed", { exact: true }).waitFor();
      await queue.getByText(prompt, { exact: true }).waitFor();
      const storedAfterClear = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored failed row after clear",
      );
      expect(storedAfterClear.sendState).toBe("failed");
      expect(storedAfterClear.transcriptRevision).toEqual({
        expectedLeafEntryId: renderedLeaf,
        sessionId: sourceSessionId,
      });
      await releaseBrowserPostRejectionHistoryHold(page);
      browserHistoryHoldArmed = false;
      await expect
        .poll(async () => (await readBrowserPostRejectionHistoryHold(page)).historyReleased)
        .toBe(true);
      await page.waitForTimeout(250);
      const chatSendsAfterSupersededImmediateRetry = observedChatSends.length;
      expect(observedChatSends).toHaveLength(chatSendsBeforeImmediateRetry);
      const storedAfterSupersededImmediateRetry = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored row after the immediate retry's stale refresh is superseded",
      );
      expect(storedAfterSupersededImmediateRetry).toMatchObject({ sendState: "failed" });
      expect(storedAfterSupersededImmediateRetry.transcriptRevision).toEqual({
        expectedLeafEntryId: renderedLeaf,
        sessionId: sourceSessionId,
      });
      const historyHoldAfterRelease = await readBrowserPostRejectionHistoryHold(page);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "04-failed-row-after-clear.png"),
      });

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const slashMenu = page.locator(".slash-menu");
      await expect.poll(() => slashMenu.count()).toBe(1);
      await expect.poll(() => slashMenu.isVisible()).toBe(true);
      await composer.focus();
      await page.keyboard.press("Escape");
      await expect.poll(() => slashMenu.count()).toBe(0);

      const providerRequestsBeforeRetry = modelServer.requests.length;
      releaseHeldResponse = modelServer.holdNextResponse();
      await retryButton.click();
      await expect.poll(() => observedChatSends.length).toBe(2);
      const retrySend = observedChatSends[1]!;
      expect(retrySend).toMatchObject({
        expectedLeafEntryId: resetBoundaryEntryId,
        message: prompt,
        sessionId: postResetSessionId,
      });
      expect(retrySend).not.toMatchObject({
        expectedLeafEntryId: renderedLeaf,
        sessionId: sourceSessionId,
      });
      await expect.poll(() => observedChatResponses.length).toBe(2);
      const retryGatewayResponse = observedChatResponses[1]!;
      expect(retryGatewayResponse).toMatchObject({
        id: retrySend.requestId,
        ok: true,
        type: "res",
      });
      await expect
        .poll(() => modelServer.requests.length, { timeout: waitTimeoutMs })
        .toBe(providerRequestsBeforeRetry + 1);
      const storedWhileProviderHeld = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored retry row while provider response is held",
      );
      const persistedRevisionWhileProviderHeld = requireRecord(
        storedWhileProviderHeld.transcriptRevision,
        "persisted retry revision while provider response is held",
      );
      expect(persistedRevisionWhileProviderHeld).toEqual({
        expectedLeafEntryId: resetBoundaryEntryId,
        sessionId: postResetSessionId,
      });
      await page
        .locator(".chat-thread-inner .chat-text, .chat-queue__text")
        .filter({ hasText: prompt })
        .first()
        .waitFor();

      releaseHeldResponse();
      releaseHeldResponse = undefined;
      await page.getByText(postClearRetryReply, { exact: true }).waitFor({
        timeout: waitTimeoutMs,
      });
      expect(modelServer.requests.length).toBe(providerRequestsBeforeRetry + 1);
      let retryFinalActiveRunIds: string[] = [];
      await expect
        .poll(async () => {
          const history = requireRecord(
            await controller!.request("chat.history", {
              limit: 100,
              sessionKey: proofSessionKey,
            }),
            "settled reset-boundary retry history",
          );
          const sessionInfo = requireRecord(
            history.sessionInfo,
            "settled reset-boundary retry session info",
          );
          retryFinalActiveRunIds = requireStringArray(
            sessionInfo.activeRunIds,
            "settled reset-boundary retry active run IDs",
          );
          return retryFinalActiveRunIds.length === 0;
        })
        .toBe(true);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "05-reset-boundary-guard-retry-accepted.png"),
      });
      const resetBoundaryGuardEquality = {
        allEqual:
          browserPostResetSessionInfo.activeLeafEntryId === resetBoundaryEntryId &&
          clearedSessionInfo.activeLeafEntryId === resetBoundaryEntryId &&
          retrySend.expectedLeafEntryId === resetBoundaryEntryId &&
          persistedRevisionWhileProviderHeld.expectedLeafEntryId === resetBoundaryEntryId,
        browserHistoryEqualsBoundary:
          browserPostResetSessionInfo.activeLeafEntryId === resetBoundaryEntryId,
        controllerHistoryEqualsBoundary:
          clearedSessionInfo.activeLeafEntryId === resetBoundaryEntryId,
        persistedOutboxEqualsBoundary:
          persistedRevisionWhileProviderHeld.expectedLeafEntryId === resetBoundaryEntryId,
        rawRetryEqualsBoundary: retrySend.expectedLeafEntryId === resetBoundaryEntryId,
      };
      expect(resetBoundaryGuardEquality).toEqual({
        allEqual: true,
        browserHistoryEqualsBoundary: true,
        controllerHistoryEqualsBoundary: true,
        persistedOutboxEqualsBoundary: true,
        rawRetryEqualsBoundary: true,
      });
      const nativeWebSocketTrace = {
        guardEquality: resetBoundaryGuardEquality,
        immediateRetryRace: {
          chatSendsAfterSupersededRetry: chatSendsAfterSupersededImmediateRetry,
          chatSendsBeforeRetry: chatSendsBeforeImmediateRetry,
          chatSendsWhileHistoryHeld: chatSendsWhileImmediateRetryBlocked,
          failedRevisionAfterSupersede: storedAfterSupersededImmediateRetry.transcriptRevision,
          failedRevisionWhileHeld: storedWhileImmediateRetryBlocked.transcriptRevision,
          historyHoldAfterRelease,
          historyHoldBeforeRetry: historyHoldBeforeImmediateRetry,
          historyHoldWhileRetryBlocked: historyHoldWhileImmediateRetryBlocked,
          noSecondSendAfterSupersede:
            chatSendsAfterSupersededImmediateRetry === chatSendsBeforeImmediateRetry,
          noSecondSendWhileHeld:
            chatSendsWhileImmediateRetryBlocked === chatSendsBeforeImmediateRetry,
          postRejectionHistoryRequestId: postRejectionHistoryRequest?.requestId,
          postRejectionHistoryRequestObservedAfterSend: postRejectionHistoryRequest !== undefined,
          postRejectionHistoryResponseOk: postRejectionHistoryResponse.ok,
          realGatewayResponseHeldBeforeUiApply: true,
          rowRemainedFailedAfterSupersede:
            storedAfterSupersededImmediateRetry.sendState === "failed",
          rowRemainedFailedWhileHeld: storedWhileImmediateRetryBlocked.sendState === "failed",
        },
        sessionReset: {
          key: resetRequest.params.key,
          postLifecycleRevision: postResetLifecycleRevision,
          preLifecycleRevision: preResetLifecycleRevision,
          requestId: resetRequest.requestId,
          responseKey: resetResponsePayload.key,
          responseOk: resetResponse.ok,
          sessionId: postResetSessionId,
          sessionIdRetainedAcrossReset: postResetSessionId === switchedSessionId,
        },
        postResetHistory: {
          browserActiveLeafEntryId: browserPostResetSessionInfo.activeLeafEntryId,
          browserHistoryRequestObserved: true,
          browserHistoryResponseOk: postResetHistoryResponse.ok,
          browserMessageCount: browserPostResetMessages.length,
          browserSessionId: browserPostResetSessionId,
          controllerActiveLeafEntryId: clearedSessionInfo.activeLeafEntryId,
          controllerMessageCount: clearedHistory.messages.length,
          controllerSessionId: controllerPostResetSessionId,
          requestSessionKey: postResetHistoryRequest.params.sessionKey,
        },
        sqliteReset: {
          lifecycleRevision: postResetSqliteEntry?.lifecycleRevision,
          lifecycleRevisionChanged:
            postResetSqliteEntry?.lifecycleRevision !== preResetLifecycleRevision,
          resetBoundary: {
            differsFromQueuedLeafEntryId: resetBoundaryEntryId !== renderedLeaf,
            entryId: resetBoundaryEntryId,
            hasFirstKeptEntryId: resetBoundaryHasFirstKeptEntryId,
            parentId: resetBoundary.parentId,
            reason: resetBoundary.reason,
            type: resetBoundary.type,
          },
          resetBoundaryAppended: resetBoundary.type === "reset" && resetBoundary.reason === "reset",
          sessionId: postResetSqliteEntry?.sessionId,
        },
        persistedOutboxWhileProviderHeld: {
          expectedLeafEntryId: persistedRevisionWhileProviderHeld.expectedLeafEntryId,
          sessionId: persistedRevisionWhileProviderHeld.sessionId,
        },
        retryChatSend: {
          expectedLeafEntryId: retrySend.expectedLeafEntryId,
          message: retrySend.message,
          requestId: retrySend.requestId,
          responseOk: retryGatewayResponse.ok,
          sessionId: retrySend.sessionId,
        },
        terminalBarrier: {
          activeRunIds: retryFinalActiveRunIds,
          observedVia: "controller-chat.history",
        },
        transport: "browser-native-websocket",
      };
      await writeFile(
        path.join(artifactDir, "05-reset-boundary-retry-native-ws-trace.json"),
        `${JSON.stringify(nativeWebSocketTrace, null, 2)}\n`,
      );
      proof.resetBoundaryGuardedRetry = {
        browserActiveLeafEntryId: browserPostResetSessionInfo.activeLeafEntryId,
        browserHistoryRequestAfterReset: true,
        browserHistoryResponseOk: postResetHistoryResponse.ok,
        browserPostResetMessageCount: browserPostResetMessages.length,
        controllerActiveLeafEntryId: clearedSessionInfo.activeLeafEntryId,
        controllerPostResetMessageCount: clearedHistory.messages.length,
        failedRowOldRevisionAfterClear: storedAfterClear.transcriptRevision,
        finalActiveRunIdsAfterRetry: retryFinalActiveRunIds,
        gatewayAcceptedRetry: retryGatewayResponse.ok,
        guardEquality: resetBoundaryGuardEquality,
        immediateRetryRace: nativeWebSocketTrace.immediateRetryRace,
        queuedRevisionLeafEntryId: renderedLeaf,
        queuedRevisionSessionId: sourceSessionId,
        postResetLifecycleRevision,
        postResetSessionId: browserPostResetSessionId,
        preResetLifecycleRevision,
        preResetSessionId: switchedSessionId,
        persistedExpectedLeafEntryId: persistedRevisionWhileProviderHeld.expectedLeafEntryId,
        persistedRevisionWhileProviderHeld,
        providerRequestsAfterRetry: modelServer.requests.length,
        providerRequestsBeforeRetry,
        resetBoundaryDiffersFromQueuedLeafEntryId: resetBoundaryEntryId !== renderedLeaf,
        resetBoundaryEntryId,
        resetBoundaryHasFirstKeptEntryId,
        resetBoundaryParentId: resetBoundary.parentId,
        resetBoundaryReason: resetBoundary.reason,
        resetBoundaryType: resetBoundary.type,
        retryExpectedLeafEntryId: retrySend.expectedLeafEntryId,
        retrySessionId: retrySend.sessionId,
        sessionIdRetainedAcrossReset: postResetSessionId === switchedSessionId,
        sessionResetRequestObserved: true,
        sessionResetResponseOk: resetResponse.ok,
        slashMenuDismissedWithEscape: true,
        sqliteLifecycleRevisionChanged:
          postResetSqliteEntry?.lifecycleRevision !== preResetLifecycleRevision,
        sqliteResetBoundaryAppended:
          resetBoundary.type === "reset" && resetBoundary.reason === "reset",
        status: "pass",
        visibleReply: postClearRetryReply,
      };
    } finally {
      if (browserHistoryHoldArmed) {
        await releaseBrowserPostRejectionHistoryHold(page).catch(() => undefined);
      }
      releaseHeldResponse?.();
      await closeContextWithVideo(context, page, "02-restored-cross-branch-needs-review.webm");
    }
  }, 240_000);

  it("keeps /steer owned by the exact active run after pane identity drifts", async () => {
    const sessionId = "pr-116382-exact-run-generation";
    const renderedLeaf = "pr-116382-exact-run-rendered-leaf";
    const providerRequestsBeforeRun = modelServer.requests.length;
    await seedSession({
      sessionId,
      events: [
        {
          content: "The exact-run proof starts from this rendered leaf.",
          eventId: renderedLeaf,
          parentId: null,
        },
      ],
    });
    const {
      context,
      observedAgentEvents,
      observedChatEvents,
      observedChatResponses,
      observedChatSends,
      observedGatewayRequests,
      observedGatewayResponses,
      page,
    } = await createRealGatewayPage();
    let releaseInitialResponse: (() => void) | undefined;
    let releaseSteeredResponse: (() => void) | undefined;

    try {
      await page.goto(`${uiServer.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
      await page
        .getByText("The exact-run proof starts from this rendered leaf.", { exact: true })
        .waitFor();

      releaseInitialResponse = modelServer.holdNextResponse();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(exactRunInitialPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => observedChatSends.length).toBe(1);
      const initialSend = observedChatSends[0]!;
      const targetRunId = requireNonEmptyString(
        initialSend.idempotencyKey,
        "initial exact target run ID",
      );
      expect(initialSend).toMatchObject({
        expectedLeafEntryId: renderedLeaf,
        message: exactRunInitialPrompt,
        sessionId,
      });
      expect(initialSend.queueMode).toBeUndefined();
      expect(initialSend.expectedRunId).toBeUndefined();
      await expect
        .poll(() => observedChatResponses.some((response) => response.id === initialSend.requestId))
        .toBe(true);
      const initialAdmissionResponse = observedChatResponses.find(
        (response) => response.id === initialSend.requestId,
      )!;
      expect(initialAdmissionResponse).toMatchObject({ ok: true, type: "res" });
      const initialAdmissionPayload = requireRecord(
        initialAdmissionResponse.payload,
        "initial exact-run admission payload",
      );
      expect(initialAdmissionPayload).toMatchObject({ runId: targetRunId, status: "started" });
      await expect.poll(() => modelServer.requests.length).toBe(providerRequestsBeforeRun + 1);

      let activeLeafBeforeSteer = "";
      let activeRunIdsBeforeSteer: string[] = [];
      await expect
        .poll(async () => {
          const history = requireRecord(
            await controller!.request("chat.history", {
              limit: 100,
              sessionKey: proofSessionKey,
            }),
            "exact-run history before steer",
          );
          const sessionInfo = requireRecord(
            history.sessionInfo,
            "exact-run session info before steer",
          );
          const leaf = sessionInfo.activeLeafEntryId;
          const runIds = requireStringArray(
            sessionInfo.activeRunIds,
            "exact-run active IDs before steer",
          );
          if (
            typeof leaf !== "string" ||
            leaf === renderedLeaf ||
            runIds.length !== 1 ||
            runIds[0] !== targetRunId
          ) {
            return false;
          }
          activeLeafBeforeSteer = leaf;
          activeRunIdsBeforeSteer = runIds;
          return true;
        })
        .toBe(true);

      await expect.poll(async () => (await readBrowserSteerState(page)).chatLoading).toBe(false);
      const browserHistoryRequestIdsBeforeRefresh = new Set(
        observedGatewayRequests
          .filter((request) => request.method === "chat.history")
          .map((request) => request.requestId),
      );
      await refreshBrowserSteerState(page);
      let browserHistoryRefreshRequest: ObservedGatewayRequest | undefined;
      await expect
        .poll(() => {
          browserHistoryRefreshRequest = observedGatewayRequests.find(
            (request) =>
              request.method === "chat.history" &&
              !browserHistoryRequestIdsBeforeRefresh.has(request.requestId),
          );
          return browserHistoryRefreshRequest !== undefined;
        })
        .toBe(true);
      if (!browserHistoryRefreshRequest) {
        throw new Error("browser refresh did not issue a new chat.history request");
      }
      const browserHistoryRefreshRequestId = requireNonEmptyString(
        browserHistoryRefreshRequest.requestId,
        "browser refresh chat.history request ID",
      );
      let browserHistoryRefreshResponse: Record<string, unknown> | undefined;
      await expect
        .poll(() => {
          browserHistoryRefreshResponse = observedGatewayResponses.find(
            (response) => response.id === browserHistoryRefreshRequestId,
          );
          return browserHistoryRefreshResponse;
        })
        .toMatchObject({ ok: true, type: "res" });
      await expect
        .poll(async () => {
          const browserState = await readBrowserSteerState(page);
          return {
            activeLeafEntryId: browserState.activeLeafEntryId,
            activeRunIds: browserState.activeRunIds,
            chatRunId: browserState.chatRunId,
            displayedLeafEntryId: browserState.displayedLeafEntryId,
          };
        })
        .toEqual({
          activeLeafEntryId: activeLeafBeforeSteer,
          activeRunIds: [targetRunId],
          chatRunId: targetRunId,
          displayedLeafEntryId: activeLeafBeforeSteer,
        });
      const browserStateBeforeDrift = await readBrowserSteerState(page);
      const browserDisplayedLeafBeforeDrift = requireNonEmptyString(
        browserStateBeforeDrift.displayedLeafEntryId,
        "browser displayed leaf before exact-run drift",
      );
      const browserActiveRunIdsBeforeDrift = requireStringArray(
        browserStateBeforeDrift.activeRunIds,
        "browser active run IDs before exact-run drift",
      );
      expect(browserActiveRunIdsBeforeDrift).toEqual([targetRunId]);
      expect(browserDisplayedLeafBeforeDrift).toBe(activeLeafBeforeSteer);
      expect(browserStateBeforeDrift.chatRunId).toBe(targetRunId);
      const browserHistoryRefresh = {
        activeRunIds: browserActiveRunIdsBeforeDrift,
        displayedLeafEntryId: browserDisplayedLeafBeforeDrift,
        requestId: browserHistoryRefreshRequestId,
        responseOk: browserHistoryRefreshResponse?.ok === true,
        transport: "browser-native-websocket",
      };
      const browserSessionLeafBeforeDrift = requireNonEmptyString(
        browserStateBeforeDrift.activeLeafEntryId,
        "browser session leaf before exact-run drift",
      );
      expect(browserSessionLeafBeforeDrift).toBe(activeLeafBeforeSteer);
      expect(stalePaneRunId).not.toBe(targetRunId);
      const browserOwnershipDrift = await seedBrowserSteerOwnershipDrift(
        page,
        targetRunId,
        renderedLeaf,
        activeLeafBeforeSteer,
      );
      expect(browserOwnershipDrift).toMatchObject({
        activeLeafEntryIdAfterDrift: renderedLeaf,
        displayedLeafEntryIdAfterDrift: activeLeafBeforeSteer,
        displayedLeafEntryIdBeforeDrift: activeLeafBeforeSteer,
        paneRunIdBeforeDrift: targetRunId,
        paneRunIdAfterDrift: stalePaneRunId,
        targetRunId,
      });
      expect(browserOwnershipDrift.activeLeafEntryIdBeforeDrift).toBe(
        browserSessionLeafBeforeDrift,
      );
      const browserStateAfterDrift = await readBrowserSteerState(page);
      expect(browserStateAfterDrift).toMatchObject({
        activeLeafEntryId: renderedLeaf,
        chatRunId: stalePaneRunId,
        displayedLeafEntryId: activeLeafBeforeSteer,
      });

      // The first provider call already consumed its hold, so arm a separate
      // gate for the queued steer turn before allowing the active turn to advance.
      releaseSteeredResponse = modelServer.holdNextResponse();
      await composer.fill(exactRunSlashCommand);
      await page.getByRole("button", { name: "Steer into the active run" }).click();
      await expect.poll(() => observedChatSends.length).toBe(2);
      const steerSend = observedChatSends[1]!;
      const steerClientRunId = requireNonEmptyString(
        steerSend.idempotencyKey,
        "exact steer client run ID",
      );
      expect(steerClientRunId).not.toBe(targetRunId);
      expect(steerSend).toMatchObject({
        deliver: false,
        expectedLeafEntryId: renderedLeaf,
        expectedRunId: targetRunId,
        message: exactRunSteerPrompt,
        queueMode: "steer",
        sessionKey: proofSessionKey,
      });
      expect(steerSend.expectedLeafEntryId).not.toBe(activeLeafBeforeSteer);
      await expect
        .poll(() => observedChatResponses.some((response) => response.id === steerSend.requestId))
        .toBe(true);
      const steerAdmissionResponse = observedChatResponses.find(
        (response) => response.id === steerSend.requestId,
      )!;
      expect(steerAdmissionResponse).toMatchObject({ ok: true, type: "res" });
      const steerAdmissionPayload = requireRecord(
        steerAdmissionResponse.payload,
        "exact steer admission payload",
      );
      expect(steerAdmissionPayload).toMatchObject({
        runId: steerClientRunId,
        status: "started",
      });
      await expect
        .poll(async () => {
          const browserState = await readBrowserSteerState(page);
          const pending = browserState.pending;
          return (
            browserState.chatRunId === stalePaneRunId &&
            pending?.kind === "steered" &&
            pending.pendingRunId === targetRunId &&
            pending.steerTargetRunId === targetRunId &&
            pending.text === exactRunSlashCommand
          );
        })
        .toBe(true);
      const pendingOwnershipBeforeInitialRelease = requireRecord(
        (await readBrowserSteerState(page)).pending,
        "pending /steer ownership before initial release",
      );
      expect(modelServer.requests.length).toBe(providerRequestsBeforeRun + 1);
      const providerRequestsBeforeInitialRelease = modelServer.requests.length;

      releaseInitialResponse();
      releaseInitialResponse = undefined;
      await expect.poll(() => modelServer.requests.length).toBe(providerRequestsBeforeRun + 2);
      const providerRequestsWhileSteeredResponseHeld = modelServer.requests.length;
      const pendingOwnershipWhileSteeredResponseHeld = requireRecord(
        (await readBrowserSteerState(page)).pending,
        "pending /steer ownership while steered response held",
      );
      expect(pendingOwnershipWhileSteeredResponseHeld).toEqual(
        pendingOwnershipBeforeInitialRelease,
      );
      const steeredProviderRequest = modelServer.requests[providerRequestsBeforeRun + 1];
      expect(JSON.stringify(modelServer.requests[providerRequestsBeforeRun]?.body)).not.toContain(
        exactRunSteerPrompt,
      );
      expect(JSON.stringify(steeredProviderRequest?.body)).toContain(exactRunSteerPrompt);
      await expect
        .poll(() =>
          observedChatEvents.some(
            (event) => event.runId === steerClientRunId && event.state === "final",
          ),
        )
        .toBe(true);

      let activeLeafWhileSteeredResponseHeld = "";
      let activeRunIdsWhileSteeredResponseHeld: string[] = [];
      await expect
        .poll(async () => {
          const history = requireRecord(
            await controller!.request("chat.history", {
              limit: 100,
              sessionKey: proofSessionKey,
            }),
            "exact-run history while steered response held",
          );
          const sessionInfo = requireRecord(
            history.sessionInfo,
            "exact-run session info while steered response held",
          );
          const leaf = sessionInfo.activeLeafEntryId;
          const runIds = requireStringArray(
            sessionInfo.activeRunIds,
            "exact-run active IDs while steered response held",
          );
          if (
            typeof leaf !== "string" ||
            leaf === activeLeafBeforeSteer ||
            runIds.length !== 1 ||
            runIds[0] !== targetRunId ||
            !JSON.stringify(history.messages).includes(exactRunSteerPrompt)
          ) {
            return false;
          }
          activeLeafWhileSteeredResponseHeld = leaf;
          activeRunIdsWhileSteeredResponseHeld = runIds;
          return true;
        })
        .toBe(true);

      releaseSteeredResponse();
      releaseSteeredResponse = undefined;
      await expect
        .poll(() =>
          observedChatEvents.some(
            (event) => event.runId === targetRunId && event.state === "final",
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          observedAgentEvents.some((event) => {
            if (event.runId !== targetRunId || event.stream !== "lifecycle") {
              return false;
            }
            const data = event.data;
            return (
              Boolean(data) &&
              typeof data === "object" &&
              !Array.isArray(data) &&
              (data as Record<string, unknown>).phase === "end"
            );
          }),
        )
        .toBe(true);
      const visibleReplyGroupBeforeTerminalRefresh = page
        .locator(".chat-thread .chat-group.assistant")
        .filter({ hasText: exactRunSteerReply })
        .last();
      await visibleReplyGroupBeforeTerminalRefresh.waitFor({ timeout: waitTimeoutMs });
      const visibleReplyTextBeforeTerminalRefresh =
        await visibleReplyGroupBeforeTerminalRefresh.textContent();
      expect(visibleReplyTextBeforeTerminalRefresh).toContain(exactRunSteerReply);
      const providerRequestsAfterCompletion = modelServer.requests.length;
      expect(providerRequestsAfterCompletion).toBe(providerRequestsBeforeRun + 2);
      expect(observedChatSends).toHaveLength(2);
      await expect.poll(async () => (await readBrowserSteerState(page)).pending).toBeNull();
      const browserStateBeforeTerminalRefresh = await readBrowserSteerState(page);
      const pendingClearedAfterTargetCompletion =
        browserStateBeforeTerminalRefresh.pending === null;
      expect(pendingClearedAfterTargetCompletion).toBe(true);

      let acceptedHistory: Record<string, unknown> | undefined;
      let finalActiveRunIds: string[] = [];
      await expect
        .poll(async () => {
          const history = requireRecord(
            await controller!.request("chat.history", {
              limit: 100,
              sessionKey: proofSessionKey,
            }),
            "settled exact-run history",
          );
          const sessionInfo = requireRecord(history.sessionInfo, "settled exact-run session info");
          const runIds = requireStringArray(
            sessionInfo.activeRunIds,
            "settled exact-run active IDs",
          );
          finalActiveRunIds = runIds;
          if (runIds.length !== 0) {
            return false;
          }
          acceptedHistory = history;
          return true;
        })
        .toBe(true);
      const settledHistory = requireRecord(acceptedHistory, "accepted exact-run history");
      const settledSessionInfo = requireRecord(
        settledHistory.sessionInfo,
        "accepted exact-run session info",
      );
      const finalActiveLeafEntryId = requireNonEmptyString(
        settledSessionInfo.activeLeafEntryId,
        "settled exact-run active leaf",
      );
      expect(settledHistory.sessionId).toBe(sessionId);
      expect(JSON.stringify(settledHistory.messages)).toContain(exactRunInitialPrompt);
      expect(JSON.stringify(settledHistory.messages)).toContain(exactRunSteerPrompt);
      expect(JSON.stringify(settledHistory.messages)).toContain(exactRunSteerReply);

      await expect.poll(async () => (await readBrowserSteerState(page)).chatLoading).toBe(false);
      const browserTerminalHistoryRequestIdsBeforeRefresh = new Set(
        observedGatewayRequests
          .filter((request) => request.method === "chat.history")
          .map((request) => request.requestId),
      );
      await refreshBrowserSteerState(page);
      let browserTerminalHistoryRefreshRequest: ObservedGatewayRequest | undefined;
      await expect
        .poll(() => {
          browserTerminalHistoryRefreshRequest = observedGatewayRequests.find(
            (request) =>
              request.method === "chat.history" &&
              request.params.sessionKey === proofSessionKey &&
              !browserTerminalHistoryRequestIdsBeforeRefresh.has(request.requestId),
          );
          return browserTerminalHistoryRefreshRequest !== undefined;
        })
        .toBe(true);
      if (!browserTerminalHistoryRefreshRequest) {
        throw new Error("terminal browser refresh did not issue a new chat.history request");
      }
      const browserTerminalHistoryRefreshRequestId = requireNonEmptyString(
        browserTerminalHistoryRefreshRequest.requestId,
        "terminal browser refresh chat.history request ID",
      );
      let browserTerminalHistoryRefreshResponse: Record<string, unknown> | undefined;
      await expect
        .poll(() => {
          browserTerminalHistoryRefreshResponse = observedGatewayResponses.find(
            (response) => response.id === browserTerminalHistoryRefreshRequestId,
          );
          return browserTerminalHistoryRefreshResponse;
        })
        .toMatchObject({ ok: true, type: "res" });
      await expect
        .poll(async () => {
          const browserState = await readBrowserSteerState(page);
          return {
            activeLeafEntryId: browserState.activeLeafEntryId,
            activeRunIds: browserState.activeRunIds,
            chatLoading: browserState.chatLoading,
            chatRunId: browserState.chatRunId,
            displayedLeafEntryId: browserState.displayedLeafEntryId,
            pending: browserState.pending,
          };
        })
        .toEqual({
          activeLeafEntryId: finalActiveLeafEntryId,
          activeRunIds: [],
          chatLoading: false,
          chatRunId: null,
          displayedLeafEntryId: finalActiveLeafEntryId,
          pending: null,
        });
      const browserStateAfterTargetCompletion = await readBrowserSteerState(page);
      const visibleReplyGroupAfterTerminalRefresh = page
        .locator(".chat-thread .chat-group.assistant")
        .filter({ hasText: exactRunSteerReply })
        .last();
      await visibleReplyGroupAfterTerminalRefresh.waitFor({ timeout: waitTimeoutMs });
      expect(await visibleReplyGroupAfterTerminalRefresh.textContent()).toContain(
        exactRunSteerReply,
      );
      const terminalBrowserHistoryRefresh = {
        activeLeafEntryId: browserStateAfterTargetCompletion.activeLeafEntryId,
        activeRunIds: browserStateAfterTargetCompletion.activeRunIds,
        displayedLeafEntryId: browserStateAfterTargetCompletion.displayedLeafEntryId,
        paneRunIdAfterRefresh: browserStateAfterTargetCompletion.chatRunId,
        paneRunIdBeforeRefresh: browserStateBeforeTerminalRefresh.chatRunId,
        pendingAfterRefresh: browserStateAfterTargetCompletion.pending,
        pendingClearedBeforeRefresh: pendingClearedAfterTargetCompletion,
        replyVisibleAfterRefresh: true,
        replyVisibleBeforeRefresh: true,
        requestId: browserTerminalHistoryRefreshRequestId,
        responseOk: browserTerminalHistoryRefreshResponse?.ok === true,
        transport: "browser-native-websocket",
      };
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "06-exact-run-steer-accepted.png"),
      });

      const agentEventRunIds = [
        ...new Set(
          observedAgentEvents.flatMap((event) =>
            typeof event.runId === "string" ? [event.runId] : [],
          ),
        ),
      ];
      const targetLifecyclePhases = observedAgentEvents.flatMap((event) => {
        if (event.runId !== targetRunId || event.stream !== "lifecycle") {
          return [];
        }
        const data = event.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return [];
        }
        const phase = (data as Record<string, unknown>).phase;
        return typeof phase === "string" ? [phase] : [];
      });
      const chatFinalRunIds = [
        ...new Set(
          observedChatEvents.flatMap((event) =>
            event.state === "final" && typeof event.runId === "string" ? [event.runId] : [],
          ),
        ),
      ];
      expect(targetLifecyclePhases.filter((phase) => phase === "start")).toHaveLength(1);
      expect(targetLifecyclePhases.filter((phase) => phase === "end")).toHaveLength(1);
      expect(chatFinalRunIds).toEqual(expect.arrayContaining([targetRunId, steerClientRunId]));
      // Embedded steering legitimately opens another provider request. The agent
      // lifecycle identity distinguishes that continuation from a successor run.
      const noSuccessorDispatch = {
        activeTargetRetainedAsOnlyVisibleRun:
          activeRunIdsWhileSteeredResponseHeld.length === 1 &&
          activeRunIdsWhileSteeredResponseHeld[0] === targetRunId,
        allAgentEventsBelongToTarget:
          agentEventRunIds.length === 1 && agentEventRunIds[0] === targetRunId,
        noConcurrentProviderDispatchBeforeTargetReleased:
          providerRequestsBeforeInitialRelease === providerRequestsBeforeRun + 1,
        noThirdChatSend: observedChatSends.length === 2,
        steerClientFinalizedWithoutAgentLifecycle:
          chatFinalRunIds.includes(steerClientRunId) &&
          !agentEventRunIds.includes(steerClientRunId),
        targetLifecycleEndedOnce:
          targetLifecyclePhases.filter((phase) => phase === "end").length === 1,
        targetLifecycleStartedOnce:
          targetLifecyclePhases.filter((phase) => phase === "start").length === 1,
      };
      expect(noSuccessorDispatch).toEqual({
        activeTargetRetainedAsOnlyVisibleRun: true,
        allAgentEventsBelongToTarget: true,
        noConcurrentProviderDispatchBeforeTargetReleased: true,
        noThirdChatSend: true,
        steerClientFinalizedWithoutAgentLifecycle: true,
        targetLifecycleEndedOnce: true,
        targetLifecycleStartedOnce: true,
      });
      const nativeWebSocketTrace = {
        baseSha: candidateBaseSha,
        dataClassification: "synthetic-redacted",
        evidenceTipSha,
        gatewayMode: "real-ephemeral-process",
        mockGateway: false,
        phase: 4,
        providerBoundary: "synthetic-local-http",
        eventEvidence: {
          agentEventCount: observedAgentEvents.length,
          agentEventRunIds,
          chatFinalRunIds,
          targetLifecyclePhases,
        },
        exactRunAdmission: {
          deliver: steerSend.deliver,
          expectedLeafEntryId: steerSend.expectedLeafEntryId,
          expectedRunId: steerSend.expectedRunId,
          message: steerSend.message,
          queueMode: steerSend.queueMode,
          requestId: steerSend.requestId,
          requestSessionKey: steerSend.sessionKey,
          slashCommand: exactRunSlashCommand,
          steerClientRunId,
          responseOk: steerAdmissionResponse.ok,
          responseStatus: steerAdmissionPayload.status,
        },
        initialRunAdmission: {
          requestId: initialSend.requestId,
          responseOk: initialAdmissionResponse.ok,
          responseRunId: initialAdmissionPayload.runId,
          responseStatus: initialAdmissionPayload.status,
          targetRunId,
        },
        leafProgress: {
          activeLeafBeforeSteer,
          activeLeafWhileSteeredResponseHeld,
          browserDisplayedLeafBeforeDrift,
          browserSessionLeafBeforeDrift,
          renderedLeaf,
          staleRenderedLeafSent: steerSend.expectedLeafEntryId === renderedLeaf,
        },
        browserHistoryRefresh,
        terminalBrowserHistoryRefresh,
        noSuccessorDispatch,
        pendingOwnership: {
          beforeInitialRelease: pendingOwnershipBeforeInitialRelease,
          clearedAfterTargetCompletion: pendingClearedAfterTargetCompletion,
          whileSteeredResponseHeld: pendingOwnershipWhileSteeredResponseHeld,
        },
        providerDispatch: {
          afterCompletion: providerRequestsAfterCompletion,
          beforeRun: providerRequestsBeforeRun,
          beforeInitialRelease: providerRequestsBeforeInitialRelease,
          firstRequestContainsSteerPrompt: false,
          secondRequestContainsSteerPrompt: true,
          whileSteeredResponseHeld: providerRequestsWhileSteeredResponseHeld,
        },
        runIdentity: {
          activeRunIdsBeforeSteer,
          activeRunIdsWhileSteeredResponseHeld,
          finalActiveRunIds,
          paneRunIdAfterCompletion: browserStateAfterTargetCompletion.chatRunId,
          paneRunIdBeforeTerminalRefresh: browserStateBeforeTerminalRefresh.chatRunId,
          paneRunIdAfterDrift: stalePaneRunId,
          steerClientRunId,
          targetRunId,
        },
        uiStateDrift: browserOwnershipDrift,
        headSha: candidateHeadSha,
        transport: "browser-native-websocket",
      };
      await writeFile(
        path.join(artifactDir, "06-exact-run-steer-native-ws-trace.json"),
        `${JSON.stringify(nativeWebSocketTrace, null, 2)}\n`,
      );
      proof.exactRunSteerSameRun = {
        activeLeafBeforeSteer,
        activeLeafWhileSteeredResponseHeld,
        activeRunIdsBeforeSteer,
        activeRunIdsWhileSteeredResponseHeld,
        agentEventRunIds,
        browserDisplayedLeafBeforeDrift,
        browserHistoryRefresh,
        terminalBrowserHistoryRefresh,
        browserSessionLeafBeforeDrift,
        chatFinalRunIds,
        deliverSent: steerSend.deliver,
        expectedLeafEntryIdSent: steerSend.expectedLeafEntryId,
        expectedRunIdSent: steerSend.expectedRunId,
        finalActiveRunIds,
        gatewayAcceptedSteer: steerAdmissionResponse.ok,
        gatewaySteerStatus: steerAdmissionPayload.status,
        initialAckRunId: initialAdmissionPayload.runId,
        noSuccessorDispatch,
        paneRunIdAfterCompletion: browserStateAfterTargetCompletion.chatRunId,
        paneRunIdBeforeTerminalRefresh: browserStateBeforeTerminalRefresh.chatRunId,
        paneRunIdAfterDrift: stalePaneRunId,
        pendingClearedAfterTargetCompletion,
        pendingOwnershipBeforeInitialRelease,
        pendingOwnershipWhileSteeredResponseHeld,
        providerRequestsAfterCompletion,
        providerRequestsBeforeRun,
        providerRequestsBeforeInitialRelease,
        providerRequestsWhileSteeredResponseHeld,
        queueModeSent: steerSend.queueMode,
        renderedLeaf,
        requestSessionKey: steerSend.sessionKey,
        slashCommandSent: exactRunSlashCommand,
        staleLeafBypassedByExactRun: steerSend.expectedLeafEntryId !== activeLeafBeforeSteer,
        status: "pass",
        steerClientRunId,
        targetRunId,
        targetLifecyclePhases,
        visibleReply: exactRunSteerReply,
      };
    } finally {
      releaseInitialResponse?.();
      releaseSteeredResponse?.();
      await closeContextWithVideo(context, page, "03-exact-run-steer-accepted.webm");
    }
  }, 180_000);
});
