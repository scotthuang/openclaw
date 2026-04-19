import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { runSessionsSendA2AFlow, __testing } from "./sessions-send-tool.a2a.js";

const runAgentStepMock = vi.fn().mockResolvedValue("Test announce reply");

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: (...args: unknown[]) => runAgentStepMock(...args),
}));

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        return {} as T;
      },
    });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    runAgentStepMock.mockReset().mockResolvedValue("Test announce reply");
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });
});

describe("runSessionsSendA2AFlow ping-pong guard for autonomous sessions", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        return {} as T;
      },
    });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    runAgentStepMock.mockReset().mockResolvedValue("Test announce reply");
    vi.restoreAllMocks();
  });

  it("skips ping-pong when requester is an ACP session", async () => {
    runAgentStepMock.mockResolvedValue("I should not trigger ping-pong");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:web:user123",
      displayKey: "agent:main:web:user123",
      message: "Weather result from ACP",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 5,
      requesterSessionKey: "agent:claude:acp:7599dc0f-5c1e-4666-a2a6-7743d488765a",
      roundOneReply: "Here is the weather for Shenzhen",
    });

    // runAgentStep should only be called once – for the announce step.
    // The ping-pong loop (which would call it multiple additional times) must NOT fire.
    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
    // The single call should be the announce step
    expect(runAgentStepMock.mock.calls[0][0]).toMatchObject({
      sessionKey: "agent:main:web:user123",
      message: "Agent-to-agent announce step.",
    });
  });

  it("skips ping-pong when requester is a subagent session", async () => {
    runAgentStepMock.mockResolvedValue("I should not trigger ping-pong");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:web:user123",
      displayKey: "agent:main:web:user123",
      message: "Task result from subagent",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 5,
      requesterSessionKey: "agent:main:subagent:task-abc-123",
      roundOneReply: "Subagent task completed",
    });

    // Only the announce step, no ping-pong turns
    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
    expect(runAgentStepMock.mock.calls[0][0]).toMatchObject({
      sessionKey: "agent:main:web:user123",
      message: "Agent-to-agent announce step.",
    });
  });

  it("still runs ping-pong for regular inter-session communication", async () => {
    // First call = ping-pong turn 1 reply, second call = REPLY_SKIP to stop, third = announce
    runAgentStepMock
      .mockResolvedValueOnce("Got it, thanks!")
      .mockResolvedValueOnce("REPLY_SKIP")
      .mockResolvedValueOnce("Announce summary");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:web:user123",
      displayKey: "agent:main:web:user123",
      message: "Hey, can you check this?",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 5,
      requesterSessionKey: "agent:main:discord:group:dev",
      roundOneReply: "Sure, checking now",
    });

    // ping-pong should fire: at least 2 calls (turn 1 + turn 2 REPLY_SKIP) + 1 announce = 3
    expect(runAgentStepMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
