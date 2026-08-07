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
  requests: ModelRequest[];
  stop: () => Promise<void>;
};
type ObservedChatSend = {
  expectedLeafEntryId?: unknown;
  idempotencyKey?: unknown;
  message?: unknown;
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
      requests.push({ body: await readJsonRequest(req) });
      writeResponsesReply(res, "Same-branch send accepted by the real Gateway.", requests.length);
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
  observedChatSends: ObservedChatSend[];
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
  const observedChatSends: ObservedChatSend[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const frame = requireRecord(JSON.parse(String(payload)), "WebSocket frame");
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = requireRecord(frame.params, "chat.send params");
          observedChatSends.push({
            expectedLeafEntryId: params.expectedLeafEntryId,
            idempotencyKey: params.idempotencyKey,
            message: params.message,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          });
        }
      } catch {
        // Binary and non-JSON frames are irrelevant to this focused transport proof.
      }
    });
  });
  return { context, observedChatSends, page };
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
      proof.sameBranchBackgroundAppend && proof.restoredQueuedBranchSwitch ? "pass" : "incomplete";
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
    const prompt = "restore this queued turn after a real branch rotation";
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
    const { context, observedChatSends, page } = await createRealGatewayPage();

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
      expect(modelServer.requests).toHaveLength(1);
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
        parkedState: storedAfterRejection.sendState,
        providerRequestsAfterRejectedDrain: modelServer.requests.length,
        requestSessionId: restoredSend.sessionId,
        status: "pass",
        visibleError: "The thread switched branches — review and resend.",
      };
    } finally {
      await closeContextWithVideo(context, page, "02-restored-cross-branch-needs-review.webm");
    }
  }, 150_000);
});
