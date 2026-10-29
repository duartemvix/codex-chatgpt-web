import { expect, spyOn, test } from "bun:test";
import {
  ChatGptBrowserWorker,
  ChatGptPromptAttachmentIntegrityError,
  type BrowserTurn,
} from "../src/adapters/chatgpt-web/browser-worker";
import { browserResponsesRequest } from "../src/browser-responses";
import { defaultConfig } from "../src/config";
import type { CodexProviderConfig } from "../src/types";

test("raw browser response sends the exact input without Codex framing", async () => {
  const config = defaultConfig("full");
  config.useTemporaryChats = false;
  let capturedProvider: CodexProviderConfig | undefined;
  let capturedTurn: BrowserTurn | undefined;

  const response = await browserResponsesRequest(new Request("http://127.0.0.1/v1/browser/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/gpt-5.6-sol",
      input: "# Master prompt\n\nScore exactly these companies.",
      reasoning: { effort: "high" },
    }),
  }), config, provider => {
    capturedProvider = provider;
    return {
      async run(turn) {
        capturedTurn = turn;
        const prepared = await turn.prepare();
        expect(prepared).toEqual({
          text: "# Master prompt\n\nScore exactly these companies.",
          images: [],
          release: expect.any(Function),
        });
        prepared.release();
        return '[{"Company ID":"abc","Fit Score":"Strong Fit"}]';
      },
    };
  });

  expect(response.status).toBe(200);
  expect(capturedProvider?.chatgptWeb?.localToolsEnabled).toBeFalse();
  expect(capturedProvider?.chatgptWeb?.useTemporaryChats).toBeTrue();
  expect(capturedTurn?.capabilities.localToolsEnabled).toBeFalse();
  expect(capturedTurn?.retainConversation).toBeFalse();
  expect(capturedTurn?.preserveFailedTab).toBeFalse();
  expect(capturedTurn?.preferClipboardPaste).toBeTrue();
  expect(capturedTurn?.prepareBeforeHelper).toBeTrue();
  expect(capturedTurn?.allowCompletionWithoutAction).toBeTrue();
  expect(capturedTurn?.modelId).toBe("gpt-5.6-sol");
  expect(capturedTurn?.reasoning).toBe("high");
  expect(await response.json()).toMatchObject({
    object: "browser.response",
    status: "completed",
    model: "chatgpt-web/gpt-5.6-sol",
    output_text: '[{"Company ID":"abc","Fit Score":"Strong Fit"}]',
  });
});

test("raw browser response rejects streaming and manual interaction", async () => {
  const automatic = defaultConfig("browser-only");
  const streaming = await browserResponsesRequest(new Request("http://127.0.0.1/v1/browser/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "hello", stream: true }),
  }), automatic, () => ({ run: async () => "unused" }));
  expect(streaming.status).toBe(400);

  const manual = defaultConfig("browser-only");
  manual.browserInteractionMode = "manual";
  const zeroRisk = await browserResponsesRequest(new Request("http://127.0.0.1/v1/browser/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/zero-risk", input: "hello" }),
  }), manual, () => ({ run: async () => "unused" }));
  expect(zeroRisk.status).toBe(409);
});

test("raw browser responses isolate helper lifecycles and can run concurrently", async () => {
  const config = defaultConfig("full");
  const prompts: string[] = [];
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let closed = 0;
  let releaseBoth!: () => void;
  const bothStarted = new Promise<void>(resolve => { releaseBoth = resolve; });
  const isolated = spyOn(ChatGptBrowserWorker, "createIsolated").mockImplementation(() => ({
    async run(turn: BrowserTurn) {
      const prepared = await turn.prepare();
      prompts.push(prepared.text);
      prepared.release();
      active += 1;
      maxActive = Math.max(maxActive, active);
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      active -= 1;
      return `answer-${prepared.text}`;
    },
    async close() {
      closed += 1;
    },
  }) as unknown as ChatGptBrowserWorker);

  try {
    const responses = await Promise.all(["first raw request", "second raw request"].map(input => (
      browserResponsesRequest(new Request("http://127.0.0.1/v1/browser/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input }),
      }), config)
    )));
    for (const response of responses) {
      expect(response.status).toBe(200);
    }
    expect(isolated).toHaveBeenCalledTimes(2);
  } finally {
    isolated.mockRestore();
  }

  expect(maxActive).toBe(2);
  expect(closed).toBe(2);
  expect(prompts.sort()).toEqual(["first raw request", "second raw request"]);
});

test("raw browser responses expose prompt attachment failures as non-retryable", async () => {
  const config = defaultConfig("full");
  const response = await browserResponsesRequest(new Request("http://127.0.0.1/v1/browser/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "large prompt" }),
  }), config, () => ({
    run: async () => {
      throw new ChatGptPromptAttachmentIntegrityError("ChatGPT prompt attachment timed out before submission");
    },
  }));

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: {
      type: "server_error",
      code: "prompt_attachment_integrity",
      message: "ChatGPT prompt attachment timed out before submission",
      retryable: false,
    },
  });
});
