import { describe, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage, type GroupedMessageProps } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";

function props(message: unknown): GroupedMessageProps {
  return {
    preparation: prepareChatMessageRender(message),
    messageKey: "incoming-message",
    options: { isStreaming: false, showReasoning: false },
  };
}

function incoming(text: string, overrides: Record<string, unknown> = {}) {
  return {
    role: "user",
    content: "What does this message mean?",
    timestamp: 123,
    __openclaw: {
      replyToPreview: { text, senderLabel: "OpenClaw" },
      transport: { channel: "openclaw-weixin", replyToId: "external-message-123" },
    },
    ...overrides,
  };
}

describe("incoming channel quote cards", () => {
  it("shows the saved quote separately from the user's words without inventing a jump target", () => {
    const quote = 'The background check did not complete.\n<img src="x" onerror="alert(1)">';
    const view = mountSolid(GroupedMessage, props(incoming(quote)));
    const card = view.container.querySelector(".chat-quote-preview");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Quoted message");
    expect(card?.textContent).toContain("OpenClaw");
    expect(card?.querySelector("blockquote")?.textContent).toBe(quote);
    expect(card?.querySelector("img, a, button")).toBeNull();
    expect(view.container.querySelector(".chat-text")?.textContent).toContain(
      "What does this message mean?",
    );
    expect(view.container.querySelector(".chat-text")?.textContent).not.toContain(quote);
    expect(view.container.querySelector(".chat-reply-attribution__target")).toBeNull();
  });

  it("expands and collapses the saved preview and keeps it open through a message refresh", () => {
    const quote = [
      "First quoted line",
      "Second quoted line",
      "Third quoted line",
      "Final quoted line",
    ].join("\n");
    const message = incoming(quote);
    const view = mountSolid(GroupedMessage, props(message));
    const button = view.container.querySelector<HTMLButtonElement>(".chat-quote-preview__toggle")!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("Show quote");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector("blockquote")?.textContent).not.toContain(
      "Final quoted line",
    );
    button.click();
    flush();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector("blockquote")?.textContent).toBe(quote);
    view.update(props({ ...message, content: "Updated question" }));
    expect(view.container.querySelector("blockquote")?.textContent).toBe(quote);
    expect(button.textContent).toBe("Collapse");
    button.click();
    flush();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector("blockquote")?.textContent).not.toContain(
      "Final quoted line",
    );
  });

  it("keeps an unavailable-quote explanation visible as the supplied quote text", () => {
    const view = mountSolid(GroupedMessage, props(incoming("[引用消息内容未缓存]")));
    expect(view.container.querySelector("blockquote")?.textContent).toBe("[引用消息内容未缓存]");
  });

  it.each([
    { role: "assistant" },
    { __openclaw: { replyToPreview: { text: "  ", senderLabel: "OpenClaw" } } },
    {
      __openclaw: {
        replyToId: "transcript-message-123",
        replyToPreview: { text: "Web Chat quote" },
      },
    },
    { __openclaw: undefined },
  ])("does not add a channel card to an ordinary or transcript-linked message: %j", (overrides) => {
    const view = mountSolid(GroupedMessage, props(incoming("Saved channel quote", overrides)));
    expect(view.container.querySelector(".chat-quote-preview")).toBeNull();
  });
});
