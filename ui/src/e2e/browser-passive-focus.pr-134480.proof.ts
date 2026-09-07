import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { getDeterministicFreePortBlock } from "../../../src/test-utils/ports.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const targetTitle = "Passive focus target";
const targetBody = "PASSIVE-FOCUS-EVALUATE-CANARY";

type VisibilityObservation = {
  changes: number;
  state: DocumentVisibilityState;
  title: string;
};

type TabStripObservation = {
  active: boolean;
  browserContextId: string;
  index: number;
  targetId: string;
  title: string;
  windowId: number;
};

type ExternalBrowserObservation = {
  activeTabTitle: string;
  renderers: {
    sentinel: VisibilityObservation;
    target: VisibilityObservation;
  };
  tabStrip: {
    sentinel: TabStripObservation;
    target: TabStripObservation;
  };
};

type ExternalBrowser = {
  cdpPort: number;
  pid: number;
  close: () => Promise<void>;
  observe: () => Promise<ExternalBrowserObservation>;
  verifyAlive: () => Promise<boolean>;
};

type BrowserRequestObservation = {
  kind?: string;
  method: string;
  path: string;
  profile?: string;
  targetMatches: boolean;
};

async function trackVisibility(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tracked = window as Window & { openclawProofVisibilityChanges?: number };
    tracked.openclawProofVisibilityChanges = 0;
    document.addEventListener("visibilitychange", () => {
      tracked.openclawProofVisibilityChanges = (tracked.openclawProofVisibilityChanges ?? 0) + 1;
    });
  });
}

async function observeVisibility(page: Page): Promise<VisibilityObservation> {
  return await page.evaluate(() => ({
    changes:
      (window as Window & { openclawProofVisibilityChanges?: number })
        .openclawProofVisibilityChanges ?? 0,
    state: document.visibilityState,
    title: document.title,
  }));
}

async function observeTabStrip(cdp: CDPSession): Promise<{
  activeTabTitle: string;
  tabStrip: ExternalBrowserObservation["tabStrip"];
}> {
  // Chrome exposes current tab-strip metadata through fresh Target.getTargets
  // reads; Playwright's focus emulation makes renderer visibility unsuitable.
  const { targetInfos } = await cdp.send("Target.getTargets", {
    filter: [{ type: "tab", exclude: false }, { exclude: true }],
  });
  const observe = async (title: string): Promise<TabStripObservation> => {
    const targetInfo = targetInfos.find((candidate) => candidate.title === title);
    if (!targetInfo) {
      throw new Error(`External browser tab-strip target was absent: ${title}`);
    }
    const embedderData = asNullableRecord(targetInfo.embedderData);
    if (
      typeof embedderData?.tabActive !== "boolean" ||
      typeof embedderData.tabStripIndex !== "number" ||
      !targetInfo.browserContextId
    ) {
      throw new Error(`Chrome does not expose tab-strip activation metadata for ${title}`);
    }
    const { windowId } = await cdp.send("Browser.getWindowForTarget", {
      targetId: targetInfo.targetId,
    });
    return {
      active: embedderData.tabActive,
      browserContextId: targetInfo.browserContextId,
      index: embedderData.tabStripIndex,
      targetId: targetInfo.targetId,
      title,
      windowId,
    };
  };
  const [sentinel, target] = await Promise.all([
    observe("Sentinel active tab"),
    observe(targetTitle),
  ]);
  if (sentinel.windowId !== target.windowId) {
    throw new Error("External browser proof tabs were not in the same Chrome window");
  }
  if (sentinel.browserContextId !== target.browserContextId) {
    throw new Error("External browser proof tabs were not in the same browser context");
  }
  const active = [sentinel, target].filter((tab) => tab.active);
  if (active.length !== 1) {
    throw new Error(`Expected one active external browser tab, received ${active.length}`);
  }
  return {
    activeTabTitle: active[0]?.title ?? "",
    tabStrip: { sentinel, target },
  };
}

async function waitForActiveTabTitle(cdp: CDPSession, expectedTitle: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let observed = "";
  while (Date.now() < deadline) {
    observed = (await observeTabStrip(cdp)).activeTabTitle;
    if (observed === expectedTitle) {
      return observed;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`External Chromium active tab remained ${observed}; expected ${expectedTitle}`);
}

async function launchExternalBrowser(cdpPort: number): Promise<ExternalBrowser> {
  const profileRoot = await mkdtemp(path.join(tmpdir(), "openclaw-browser-focus-proof-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profileRoot, {
      executablePath: await realpath(chromium.executablePath()),
      headless: false,
      args: [`--remote-debugging-port=${cdpPort}`, "--window-size=1280,900"],
    });
    const sentinel = context.pages()[0] ?? (await context.newPage());
    await sentinel.setContent(
      "<title>Sentinel active tab</title><main>THIS TAB MUST STAY ACTIVE</main>",
    );
    await trackVisibility(sentinel);
    const target = await context.newPage();
    await target.setContent(`<title>${targetTitle}</title><main>${targetBody}</main>`);
    await trackVisibility(target);

    const browser = context.browser();
    if (!browser) {
      throw new Error("Persistent Chromium did not expose its browser process");
    }
    const cdp = await browser.newBrowserCDPSession();
    const processInfo = await cdp.send("SystemInfo.getProcessInfo");
    const pid = processInfo.processInfo.find((entry) => entry.type === "browser")?.id;
    if (!pid) {
      throw new Error("External Chromium browser PID was unavailable");
    }
    await sentinel.bringToFront();
    await waitForActiveTabTitle(cdp, "Sentinel active tab");
    return {
      cdpPort,
      pid,
      observe: async () => {
        const tabStrip = await observeTabStrip(cdp);
        return {
          ...tabStrip,
          renderers: {
            sentinel: await observeVisibility(sentinel),
            target: await observeVisibility(target),
          },
        };
      },
      verifyAlive: async () => {
        const current = await cdp.send("SystemInfo.getProcessInfo");
        return current.processInfo.some((entry) => entry.type === "browser" && entry.id === pid);
      },
      close: async () => {
        const errors: unknown[] = [];
        try {
          await cdp.detach();
        } catch (error) {
          errors.push(error);
        }
        try {
          await context?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await rm(profileRoot, { force: true, recursive: true });
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "External Chromium cleanup failed");
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await rm(profileRoot, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function closeOwners(owner: OpenClawTestInstance, browser: ExternalBrowser): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [() => owner.cleanup(), () => browser.close()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Browser focus proof cleanup failed");
  }
}

let instance: OpenClawTestInstance | undefined;
let externalBrowser: ExternalBrowser | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI passive browser focus with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const basePort = await getDeterministicFreePortBlock({
      offsets: [0, 1, 2, 3, 4, 8, 9, 10, 120],
    });
    const browser = await launchExternalBrowser(basePort + 120);
    externalBrowser = browser;
    let owner: OpenClawTestInstance | undefined;
    try {
      owner = await createOpenClawTestInstance({
        name: "control-ui-passive-browser-focus",
        port: basePort,
        config: {
          gateway: { controlUi: { enabled: true } },
          plugins: { allow: ["browser"] },
          browser: {
            enabled: true,
            defaultProfile: "user",
            headless: false,
            profiles: {
              user: {
                driver: "openclaw",
                cdpUrl: `http://127.0.0.1:${browser.cdpPort}`,
                attachOnly: true,
                headless: false,
              },
            },
          },
        },
        env: {
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      const startedOwner = owner;
      instance = startedOwner;
      await startedOwner.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${startedOwner.port}/`,
        close: () => closeOwners(startedOwner, browser),
      };
    } catch (error) {
      await (owner ? closeOwners(owner, browser) : browser.close()).catch(() => undefined);
      throw error;
    }
  },
});

suite.define(() => {
  it(
    "keeps passive screenshot and evaluate work in the background but focuses explicit Open",
    { timeout: 240_000 },
    async () => {
      if (!instance || !externalBrowser) {
        throw new Error("Real Gateway browser proof fixture is not running");
      }
      const owner = instance;
      const browser = externalBrowser;
      const cliJson = async <T>(method: string, params: unknown): Promise<T> => {
        const result = await owner.cli([
          "--no-color",
          "gateway",
          "call",
          method,
          "--params",
          JSON.stringify(params),
          "--json",
        ]);
        expect(result.code, `${result.stderr}\n${owner.logs()}`).toBe(0);
        return JSON.parse(result.stdout) as T;
      };
      const browserRequest = <T>(
        method: "GET" | "POST",
        requestPath: string,
        body?: Record<string, unknown>,
      ) =>
        cliJson<T>("browser.request", {
          target: "host",
          method,
          path: requestPath,
          query: { profile: "user" },
          ...(body ? { body } : {}),
          timeoutMs: 30_000,
        });
      const expectUnchangedFocus = async (expected: ExternalBrowserObservation) => {
        await expect.poll(() => browser.observe()).toEqual(expected);
        return await browser.observe();
      };

      const baseline = await browser.observe();
      expect(baseline).toMatchObject({
        activeTabTitle: "Sentinel active tab",
        renderers: {
          sentinel: { title: "Sentinel active tab" },
          target: { title: targetTitle },
        },
        tabStrip: {
          sentinel: { active: true, title: "Sentinel active tab" },
          target: { active: false, title: targetTitle },
        },
      });
      const tabs = await browserRequest<{
        running: boolean;
        tabs: Array<{ tabId?: string; targetId: string; title: string; url: string }>;
      }>("GET", "/tabs");
      expect(tabs.running).toBe(true);
      const targetTab = tabs.tabs.find((tab) => tab.title === targetTitle);
      if (!targetTab) {
        throw new Error("External target tab was absent from the real browser tab list");
      }
      const targetIds = new Set(
        [targetTab.targetId, targetTab.tabId].filter(
          (targetId): targetId is string => typeof targetId === "string",
        ),
      );

      const directScreenshot = await browserRequest<{ path?: string; targetId?: string }>(
        "POST",
        "/screenshot",
        { targetId: targetTab.targetId, type: "png" },
      );
      expect(directScreenshot.path).toMatch(/\.(?:jpe?g|png)$/u);
      const afterDirectScreenshot = await expectUnchangedFocus(baseline);

      const directEvaluate = await browserRequest<{ result?: unknown }>("POST", "/act", {
        kind: "evaluate",
        targetId: targetTab.targetId,
        fn: "() => document.body.innerText",
      });
      expect(directEvaluate.result).toBe(targetBody);
      const afterDirectEvaluate = await expectUnchangedFocus(baseline);

      const sessionKey = "agent:main:passive-browser-focus-proof";
      const session = await cliJson<{ ok: boolean; sessionId: string }>("sessions.create", {
        key: sessionKey,
        agentId: "main",
        label: "Passive browser focus proof",
      });
      expect(session.ok).toBe(true);
      const transcriptScope = {
        agentId: "main",
        sessionKey,
        sessionId: session.sessionId,
        env: owner.env,
      };
      const startedAt = Date.now();
      await appendTranscriptMessage(transcriptScope, {
        message: {
          role: "user",
          content: [{ type: "text", text: "Read the synthetic external browser target." }],
          timestamp: startedAt,
        },
      });
      await appendTranscriptMessage(transcriptScope, {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-passive-browser-focus",
              name: "browser",
              arguments: {
                action: "act",
                profile: "user",
                request: {
                  kind: "evaluate",
                  targetId: targetTab.targetId,
                  fn: "() => document.body.innerText",
                },
              },
            },
          ],
          timestamp: startedAt + 1,
        },
      });
      await appendTranscriptMessage(transcriptScope, {
        message: {
          role: "toolResult",
          toolCallId: "call-passive-browser-focus",
          toolName: "browser",
          content: [{ type: "text", text: targetBody }],
          details: {
            browserTab: {
              target: "host",
              profile: "user",
              targetId: targetTab.targetId,
              title: targetTab.title,
              url: targetTab.url,
            },
          },
          isError: false,
          timestamp: startedAt + 2,
        },
      });
      const completionText = "The external browser result is ready.";
      await appendTranscriptMessage(transcriptScope, {
        message: {
          role: "assistant",
          content: [{ type: "text", text: completionText }],
          timestamp: startedAt + 3,
        },
      });

      const dashboard = await owner.cli(["--no-color", "dashboard", "--json"]);
      expect(dashboard.code, dashboard.stderr).toBe(0);
      const issued = new URL((JSON.parse(dashboard.stdout) as { browserUrl: string }).browserUrl);
      const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
      url.hash = issued.hash;

      await suite.withPage(
        {
          locale: "en-US",
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
          permissions: ["local-network-access"],
          ...(captureEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 1000 } } }
            : {}),
        },
        async ({ page }) => {
          const requests: BrowserRequestObservation[] = [];
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => {
              let frame: unknown;
              try {
                frame = JSON.parse(payload.toString());
              } catch {
                return;
              }
              const request = asNullableRecord(frame);
              const params = asNullableRecord(request?.params);
              if (request?.method !== "browser.request" || !params) {
                return;
              }
              const body = asNullableRecord(params.body);
              const query = asNullableRecord(params.query);
              requests.push({
                method: String(params.method ?? ""),
                path: String(params.path ?? ""),
                ...(typeof body?.kind === "string" ? { kind: body.kind } : {}),
                ...(typeof query?.profile === "string" ? { profile: query.profile } : {}),
                targetMatches: typeof body?.targetId === "string" && targetIds.has(body.targetId),
              });
            });
          });
          expect((await page.goto(url.toString()))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          await page.getByText(completionText, { exact: true }).waitFor();
          const servedScripts = await page
            .locator("script[src]")
            .evaluateAll((scripts) =>
              scripts.map((script) => new URL((script as HTMLScriptElement).src).pathname),
            );
          expect(servedScripts.some((script) => /^\/assets\/index-[^.]+\.js$/u.test(script))).toBe(
            true,
          );
          const evidenceHead = process.env.OPENCLAW_PROOF_EVIDENCE_HEAD;
          expect(evidenceHead).toMatch(/^[0-9a-f]{40}$/u);
          const servedBuildId = await page
            .locator("html")
            .getAttribute("data-openclaw-control-ui-build-id");
          expect(servedBuildId).toContain(`-${evidenceHead?.slice(0, 12)}-`);

          const card = page.locator("openclaw-browser-tab-card").filter({ hasText: targetTitle });
          const cardImage = card.locator(".shot img");
          await expect
            .poll(async () =>
              (await cardImage.count()) === 1
                ? cardImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)
                : 0,
            )
            .toBeGreaterThan(0);
          await expect
            .poll(() => requests.filter((request) => request.path === "/screenshot").length)
            .toBeGreaterThan(0);
          expect(requests.filter((request) => request.path === "/tabs/focus")).toHaveLength(0);
          const afterCard = await expectUnchangedFocus(baseline);
          if (captureEnabled) {
            await page.screenshot({ path: path.join(suite.artifactDir, "01-card-passive.png") });
          }

          const panelStart = requests.length;
          await openChatSidePanelType(page, "Browser");
          const panel = page.locator("section.bp");
          const panelImage = panel.locator(`.bp-shot[alt="${targetTitle}"]`);
          await expect
            .poll(async () =>
              (await panelImage.count()) === 1
                ? panelImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)
                : 0,
            )
            .toBeGreaterThan(0);
          await expect
            .poll(() => {
              const passive = requests.slice(panelStart);
              return {
                actEvaluate: passive.some(
                  (request) => request.path === "/act" && request.kind === "evaluate",
                ),
                screenshot: passive.some((request) => request.path === "/screenshot"),
                tabs: passive.some((request) => request.path === "/tabs"),
              };
            })
            .toEqual({ actEvaluate: true, screenshot: true, tabs: true });
          const passiveRequests = requests.slice(panelStart);
          expect(passiveRequests.filter((request) => request.path === "/tabs/focus")).toHaveLength(
            0,
          );
          expect(passiveRequests.filter((request) => request.targetMatches).length).toBeGreaterThan(
            0,
          );
          const afterPanel = await expectUnchangedFocus(baseline);
          if (captureEnabled) {
            await page.screenshot({ path: path.join(suite.artifactDir, "02-panel-passive.png") });
          }

          const explicitStart = requests.length;
          await card.getByRole("button", { name: "Open", exact: true }).click();
          await expect.poll(async () => (await browser.observe()).activeTabTitle).toBe(targetTitle);
          await expect
            .poll(() => {
              const explicit = requests.slice(explicitStart);
              return {
                focus: explicit.filter((request) => request.path === "/tabs/focus").length,
                postFocusCapture: explicit.some((request) => request.path === "/screenshot"),
              };
            })
            .toEqual({ focus: 1, postFocusCapture: true });
          const explicitRequests = requests.slice(explicitStart);
          expect(explicitRequests.filter((request) => request.path === "/tabs/focus")).toHaveLength(
            1,
          );
          const processAlive = await browser.verifyAlive();
          expect(processAlive).toBe(true);
          const afterExplicitOpen = await browser.observe();
          if (captureEnabled) {
            await page.screenshot({ path: path.join(suite.artifactDir, "03-explicit-open.png") });
          }

          await writeFile(
            path.join(suite.artifactDir, "verdict.json"),
            `${JSON.stringify(
              {
                schema: "openclaw-browser-passive-focus-proof-v1",
                productHead: process.env.OPENCLAW_PROOF_PRODUCT_HEAD ?? null,
                evidenceHead: process.env.OPENCLAW_PROOF_EVIDENCE_HEAD ?? null,
                gateway: "real isolated Gateway",
                servedScripts,
                servedBuildId,
                browser: {
                  driver: "openclaw",
                  attachOnly: true,
                  headed: true,
                  processAlive,
                  pid: browser.pid,
                },
                stages: {
                  baseline,
                  directScreenshot: { focusPreserved: true, observation: afterDirectScreenshot },
                  directEvaluate: {
                    focusPreserved: true,
                    observation: afterDirectEvaluate,
                    returnedCanary: true,
                  },
                  cardThumbnail: { focusPreserved: true, observation: afterCard },
                  passivePanelFollow: {
                    focusPreserved: true,
                    observation: afterPanel,
                    requests: passiveRequests,
                  },
                  explicitCardOpen: {
                    focusedTarget: true,
                    observation: afterExplicitOpen,
                    requests: explicitRequests,
                  },
                },
                allUiBrowserRequests: requests,
              },
              null,
              2,
            )}\n`,
          );
        },
      );
    },
  );
});
