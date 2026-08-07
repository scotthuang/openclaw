// Evidence-branch-only exact-head real-Gateway browser proof for PR #116382.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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
const postClearRetryPrompt = "restore this queued turn after a real branch rotation";
const postClearRetryReply = "Post-clear retry accepted by the real Gateway.";
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
  expectedLeafEntryId?: unknown;
  idempotencyKey?: unknown;
  message?: unknown;
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
  let heldResponse: Promise<void> | undefined;
  let releaseHeldResponse: (() => void) | undefined;
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
      await heldResponse;
      const reply = JSON.stringify(body).includes(postClearRetryPrompt)
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
      if (heldResponse) {
        throw new Error("a synthetic provider response is already held");
      }
      heldResponse = new Promise<void>((resolve) => {
        releaseHeldResponse = resolve;
      });
      return () => {
        const release = releaseHeldResponse;
        heldResponse = undefined;
        releaseHeldResponse = undefined;
        release?.();
      };
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
    { sessionId: params.sessionId, updatedAt: Date.now() },
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
      ).__OPENCLAW_NATIVE_CONTROL_AUTH__ = { gatewayUrl, token };
    },
    { gatewayUrl: instance.url, token: instance.gatewayToken },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(waitTimeoutMs);
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
            expectedLeafEntryId: params.expectedLeafEntryId,
            idempotencyKey: params.idempotencyKey,
            message: params.message,
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
    observedChatResponses,
    observedChatSends,
    observedGatewayRequests,
    observedGatewayResponses,
    page,
  };
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
      proof.postClearGuardedRetry
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

  it("parks a restored queued send after a canonical branch rotation", async () => {
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
      const resetRequest = observedGatewayRequests
        .filter((request) => request.method === "sessions.reset")
        .at(-1)!;
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
        throw new Error("browser post-reset history must expose the rotated session ID");
      }
      expect(browserPostResetMessages).toEqual([]);
      expect(Object.hasOwn(browserPostResetSessionInfo, "activeLeafEntryId")).toBe(true);
      expect(browserPostResetSessionInfo.activeLeafEntryId).toBeNull();
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
      const clearedSessionId = clearedHistory.sessionId;
      if (typeof clearedSessionId !== "string" || !clearedSessionId.trim()) {
        throw new Error("post-clear history must expose the rotated session ID");
      }
      if (!Array.isArray(clearedHistory.messages)) {
        throw new Error("controller post-reset history must expose a messages array");
      }
      expect(clearedHistory.messages).toEqual([]);
      expect(Object.hasOwn(clearedSessionInfo, "activeLeafEntryId")).toBe(true);
      expect(clearedSessionInfo.activeLeafEntryId).toBeNull();
      expect(browserPostResetSessionId).toBe(clearedSessionId);
      expect(clearedSessionId).not.toBe(switchedSessionId);
      expect(clearedSessionId).not.toBe(sourceSessionId);
      expect(
        loadSessionEntry({ sessionKey: proofSessionKey, storePath: sessionStorePath() })?.sessionId,
      ).toBe(clearedSessionId);
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
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "04-failed-row-after-clear.png"),
      });

      const providerRequestsBeforeRetry = modelServer.requests.length;
      releaseHeldResponse = modelServer.holdNextResponse();
      await queue
        .locator(".chat-queue__item", { hasText: prompt })
        .locator(".chat-queue__retry")
        .click();
      await expect.poll(() => observedChatSends.length).toBe(2);
      const retrySend = observedChatSends[1]!;
      expect(retrySend).toMatchObject({
        expectedLeafEntryId: null,
        message: prompt,
        sessionId: clearedSessionId,
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
      await expect.poll(() => modelServer.requests.length).toBe(providerRequestsBeforeRetry + 1);
      const storedWhileProviderHeld = requireRecord(
        await readPersistedQueueItem(page, prompt),
        "stored retry row while provider response is held",
      );
      expect(storedWhileProviderHeld.transcriptRevision).toEqual({
        expectedLeafEntryId: null,
        sessionId: clearedSessionId,
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
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "05-null-guard-retry-accepted.png"),
      });
      const nativeWebSocketTrace = {
        sessionReset: {
          key: resetRequest.params.key,
          requestId: resetRequest.requestId,
          responseOk: resetResponse.ok,
        },
        postResetHistory: {
          activeLeafEntryId: browserPostResetSessionInfo.activeLeafEntryId,
          browserHistoryRequestObserved: true,
          browserHistoryResponseOk: postResetHistoryResponse.ok,
          messageCount: browserPostResetMessages.length,
          requestSessionKey: postResetHistoryRequest.params.sessionKey,
          sessionId: browserPostResetSessionId,
        },
        retryChatSend: {
          expectedLeafEntryId: retrySend.expectedLeafEntryId,
          message: retrySend.message,
          requestId: retrySend.requestId,
          responseOk: retryGatewayResponse.ok,
          sessionId: retrySend.sessionId,
        },
        transport: "browser-native-websocket",
      };
      await writeFile(
        path.join(artifactDir, "05-post-clear-retry-native-ws-trace.json"),
        `${JSON.stringify(nativeWebSocketTrace, null, 2)}\n`,
      );
      proof.postClearGuardedRetry = {
        activeLeafAfterClear: browserPostResetSessionInfo.activeLeafEntryId,
        browserHistoryRequestAfterReset: true,
        browserHistoryResponseOk: postResetHistoryResponse.ok,
        failedRowOldRevisionAfterClear: storedAfterClear.transcriptRevision,
        gatewayAcceptedRetry: retryGatewayResponse.ok,
        newSessionId: browserPostResetSessionId,
        oldLeafEntryId: renderedLeaf,
        oldSessionId: sourceSessionId,
        persistedRevisionWhileProviderHeld: storedWhileProviderHeld.transcriptRevision,
        providerRequestsAfterRetry: modelServer.requests.length,
        providerRequestsBeforeRetry,
        retryExpectedLeafEntryId: retrySend.expectedLeafEntryId,
        retrySessionId: retrySend.sessionId,
        sessionResetRequestObserved: true,
        sessionResetResponseOk: resetResponse.ok,
        sqliteSessionRotated: true,
        status: "pass",
        visibleReply: postClearRetryReply,
      };
    } finally {
      releaseHeldResponse?.();
      await closeContextWithVideo(context, page, "02-restored-cross-branch-needs-review.webm");
    }
  }, 240_000);
});
