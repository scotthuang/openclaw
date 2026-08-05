// Temporary exact-head browser proof for PR #116382; this file is not committed.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
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

const initialSessionId = "pr-116382-generation-before-switch";
const initialLeafEntryId = "pr-116382-leaf-before-background";
const backgroundLeafEntryId = "pr-116382-leaf-after-background";
const acceptedLeafEntryId = "pr-116382-leaf-after-accepted-send";
const switchedSessionId = "pr-116382-generation-after-switch";
const switchedLeafEntryId = "pr-116382-leaf-after-switch";
const proofSessionKey = "agent:main:main";

let browser: Browser;
let server: ControlUiE2eServer;
const proof: Record<string, unknown> = {
  headSha: process.env.OPENCLAW_PR_116382_HEAD ?? "unknown",
  startedAt: new Date().toISOString(),
  status: "running",
};

function historyResponse(params: {
  activeLeafEntryId: string;
  messages: unknown[];
  sessionId: string;
}) {
  return {
    messages: params.messages,
    sessionId: params.sessionId,
    sessionInfo: {
      activeLeafEntryId: params.activeLeafEntryId,
      branches: [
        {
          active: true,
          headline: `Active path ${params.activeLeafEntryId}`,
          leafEntryId: params.activeLeafEntryId,
          messageCount: params.messages.length,
        },
      ],
      hasActiveRun: false,
      status: "done",
    },
    thinkingLevel: null,
  };
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
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

describeProof("PR #116382 exact-head Control UI proof", () => {
  beforeAll(async () => {
    await mkdir(path.join(artifactDir, "raw-video"), { recursive: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
    proof.finishedAt = new Date().toISOString();
    proof.status =
      proof.sameBranchBackgroundAppend && proof.restoredQueuedBranchSwitch ? "pass" : "incomplete";
    await writeFile(
      path.join(artifactDir, "pr-116382-exact-head-proof.json"),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
  });

  it("records same-branch progress", async () => {
    const sameBranchInitialMessage = {
      __openclaw: { id: initialLeafEntryId, seq: 1 },
      content: [{ text: "The rendered branch is ready.", type: "text" }],
      role: "assistant",
      timestamp: Date.now() - 2_000,
    };
    const backgroundMessage = {
      __openclaw: { id: backgroundLeafEntryId, seq: 2 },
      content: [{ text: "Background progress landed on the same branch.", type: "text" }],
      role: "assistant",
      timestamp: Date.now() - 1_000,
    };
    const sameBranchPrompt = "send while same-branch history refresh is pending";
    const sameBranchReply = "Same-branch send accepted.";
    const sameBranchContext = await browser.newContext({
      locale: "en-US",
      recordVideo: {
        dir: path.join(artifactDir, "raw-video"),
        size: { height: 900, width: 1280 },
      },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const sameBranchPage = await sameBranchContext.newPage();
    const sameBranchGateway = await installMockGateway(sameBranchPage, {
      methodResponses: {
        "chat.history": historyResponse({
          activeLeafEntryId: initialLeafEntryId,
          messages: [sameBranchInitialMessage],
          sessionId: initialSessionId,
        }),
      },
      sessionKey: proofSessionKey,
    });

    try {
      await sameBranchPage.goto(`${server.baseUrl}chat`);
      await sameBranchPage.getByText("The rendered branch is ready.").waitFor({ timeout: 60_000 });
      const historyRequestsBefore = (await sameBranchGateway.getRequests("chat.history")).length;
      await sameBranchGateway.setMethodResponse(
        "chat.history",
        historyResponse({
          activeLeafEntryId: backgroundLeafEntryId,
          messages: [sameBranchInitialMessage, backgroundMessage],
          sessionId: initialSessionId,
        }),
      );
      await sameBranchGateway.deferNext("chat.history");
      await sameBranchGateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: backgroundMessage,
        messageId: backgroundLeafEntryId,
        messageSeq: 2,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: proofSessionKey,
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: proofSessionKey,
      });
      await expect
        .poll(async () => (await sameBranchGateway.getRequests("chat.history")).length)
        .toBe(historyRequestsBefore + 1);

      await sameBranchPage
        .locator(".agent-chat__composer-combobox textarea")
        .fill(sameBranchPrompt);
      await sameBranchPage.getByRole("button", { name: "Send message" }).click();
      const sameBranchSend = await sameBranchGateway.waitForRequest("chat.send");
      const sameBranchParams = requireRecord(sameBranchSend.params);
      expect(sameBranchParams).toMatchObject({
        expectedLeafEntryId: initialLeafEntryId,
        message: sameBranchPrompt,
        sessionId: initialSessionId,
      });
      const sameBranchRunId = String(sameBranchParams.idempotencyKey ?? "");
      expect(sameBranchRunId).not.toBe("");
      await sameBranchGateway.emitChatFinal({ runId: sameBranchRunId, text: sameBranchReply });
      await sameBranchPage.getByText(sameBranchReply).waitFor({ timeout: 10_000 });
      await sameBranchGateway.resolveDeferred(
        "chat.history",
        historyResponse({
          activeLeafEntryId: acceptedLeafEntryId,
          messages: [
            sameBranchInitialMessage,
            backgroundMessage,
            {
              __openclaw: {
                id: "pr-116382-user-after-background",
                idempotencyKey: `${sameBranchRunId}:user`,
                seq: 3,
              },
              content: [{ text: sameBranchPrompt, type: "text" }],
              role: "user",
              timestamp: Date.now() - 1,
            },
            {
              __openclaw: { id: acceptedLeafEntryId, seq: 4 },
              content: [{ text: sameBranchReply, type: "text" }],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
          sessionId: initialSessionId,
        }),
      );
      await sameBranchPage
        .locator(".chat-thread-inner .chat-text", {
          hasText: "Background progress landed on the same branch.",
        })
        .waitFor({ timeout: 10_000 });
      await sameBranchPage.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "01-same-branch-send-accepted.png"),
      });
      proof.sameBranchBackgroundAppend = {
        backgroundLeafEntryId,
        expectedLeafEntryIdSent: sameBranchParams.expectedLeafEntryId,
        historyRefreshInFlight: true,
        renderedReply: sameBranchReply,
        requestSessionId: sameBranchParams.sessionId,
        status: "pass",
      };
    } finally {
      await closeContextWithVideo(
        sameBranchContext,
        sameBranchPage,
        "01-same-branch-send-accepted.webm",
      );
    }
  });

  it("records restored cross-branch review", async () => {
    const queuedPrompt = "restore this queued turn after a real branch rotation";
    const queuedInitialMessage = {
      __openclaw: { id: initialLeafEntryId, seq: 1 },
      content: [{ text: "Queue this turn before switching branches.", type: "text" }],
      role: "assistant",
      timestamp: Date.now() - 1_000,
    };
    const switchedMessage = {
      __openclaw: { id: switchedLeafEntryId, seq: 1 },
      content: [{ text: "A different branch is now authoritative.", type: "text" }],
      role: "assistant",
      timestamp: Date.now(),
    };
    const restoredContext = await browser.newContext({
      locale: "en-US",
      recordVideo: {
        dir: path.join(artifactDir, "raw-video"),
        size: { height: 900, width: 1280 },
      },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const restoredPage = await restoredContext.newPage();
    const restoredGateway = await installMockGateway(restoredPage, {
      methodResponses: {
        "chat.history": historyResponse({
          activeLeafEntryId: initialLeafEntryId,
          messages: [queuedInitialMessage],
          sessionId: initialSessionId,
        }),
      },
      sessionKey: proofSessionKey,
    });

    try {
      await restoredPage.goto(`${server.baseUrl}chat`);
      await restoredPage
        .getByText("Queue this turn before switching branches.")
        .waitFor({ timeout: 60_000 });
      await restoredGateway.setOnline(false);
      await restoredPage.locator(".agent-chat__offline-hint").waitFor({ timeout: 10_000 });
      await restoredPage.locator(".agent-chat__composer-combobox textarea").fill(queuedPrompt);
      await restoredPage.getByRole("button", { name: "Send message" }).click();
      const queue = restoredPage.locator(".chat-queue");
      await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
      await queue.getByText(queuedPrompt).waitFor({ timeout: 10_000 });
      const storedBeforeReload = requireRecord(
        await readPersistedQueueItem(restoredPage, queuedPrompt),
      );
      expect(storedBeforeReload.transcriptRevision).toEqual({
        expectedLeafEntryId: initialLeafEntryId,
        sessionId: initialSessionId,
      });
      await restoredPage.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "02-queued-before-branch-switch.png"),
      });

      const switchedHistory = historyResponse({
        activeLeafEntryId: switchedLeafEntryId,
        messages: [switchedMessage],
        sessionId: switchedSessionId,
      });
      await restoredGateway.setMethodResponse("chat.history", switchedHistory);
      await restoredPage.reload();
      const storedAfterReload = requireRecord(
        await readPersistedQueueItem(restoredPage, queuedPrompt),
      );
      expect(storedAfterReload.transcriptRevision).toEqual({
        expectedLeafEntryId: initialLeafEntryId,
        sessionId: initialSessionId,
      });
      await restoredGateway.deferNext("chat.send");
      await restoredGateway.setOnline(true);
      await restoredPage
        .locator(".chat-thread-inner .chat-text", {
          hasText: "A different branch is now authoritative.",
        })
        .waitFor({ timeout: 60_000 });
      const restoredSend = await restoredGateway.waitForRequest("chat.send");
      const restoredParams = requireRecord(restoredSend.params);
      expect(restoredParams).toMatchObject({
        expectedLeafEntryId: initialLeafEntryId,
        message: queuedPrompt,
        sessionId: initialSessionId,
      });
      await restoredGateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        details: { reason: "active-leaf-changed" },
        message: "active branch changed; review and resend",
      });
      await queue.getByText("Failed").waitFor({ timeout: 10_000 });
      await queue
        .getByText("The thread switched branches — review and resend.")
        .waitFor({ timeout: 10_000 });
      const storedAfterRejection = requireRecord(
        await readPersistedQueueItem(restoredPage, queuedPrompt),
      );
      expect(storedAfterRejection.sendState).toBe("failed");
      expect(storedAfterRejection.transcriptRevision).toEqual({
        expectedLeafEntryId: initialLeafEntryId,
        sessionId: initialSessionId,
      });
      await restoredPage.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "03-restored-cross-branch-needs-review.png"),
      });
      proof.restoredQueuedBranchSwitch = {
        activeLeafAfterSwitch: switchedLeafEntryId,
        activeSessionAfterSwitch: switchedSessionId,
        expectedLeafEntryIdSent: restoredParams.expectedLeafEntryId,
        parkedState: storedAfterRejection.sendState,
        requestSessionId: restoredParams.sessionId,
        storedRevisionAfterReload: storedAfterReload.transcriptRevision,
        visibleError: "The thread switched branches — review and resend.",
        visibleState: "Failed",
        status: "pass",
      };
    } finally {
      await closeContextWithVideo(
        restoredContext,
        restoredPage,
        "02-restored-cross-branch-needs-review.webm",
      );
    }
  });
});
