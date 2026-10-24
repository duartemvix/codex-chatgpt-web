import { selectedSkillFile } from "../src/adapters/chatgpt-web/skill-attachments";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([[false, false], [false, true], [true, false], [true, true]])("helper verification preserves Temporary Chat=%s and discards retired saved-chat=%s", async (useTemporaryChats, useSavedChats) => {
  const root = mkdtempSync(join(tmpdir(), "codex-verification-chat-mode-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    // Keep the launcher request, helper protocol and worker configuration real; replace browser IO.
    ChatGptBrowserWorker.prototype.verifyConnector = async function() {
      if (Object.hasOwn(this.config, "useSavedChats")) throw new Error("Retired setting reached helper worker");
      if (this.config.useTemporaryChats !== ${useTemporaryChats}) throw new Error("Temporary Chat preference lost in verification IPC");
      return this.config.appName;
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const { verifyConnectorWithBrowserHelper } = require("../launcher/electron/browser-helper-verifier.cjs");
  expect(await verifyConnectorWithBrowserHelper({
    helper: { executable: process.execPath, script: helper },
    descriptorPath: join(root, "launcher.json"),
    appName: "Codex Native2", useTemporaryChats, useSavedChats,
  })).toEqual({ ok: true, appName: "Codex Native2" });
});

test("daemon streams browser lifecycle through the real helper process", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    // Substitute only the browser. Both sides of the production IPC protocol run unchanged.
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      if (Object.hasOwn(this.config, "useSavedChats")) throw new Error("Retired setting reached helper worker");
      if (this.config.useTemporaryChats !== true) throw new Error("Temporary Chat preference lost in turn IPC");
      if (turn.modelFamily !== "5.6") throw new Error("Pinned model family lost in helper IPC");
      await turn.onPreparedSelected(false);
      const prepared = await turn.prepare();
      if (prepared.skillFiles?.[0]?.text !== "<skill>\\n<name>ipc</name>\\n<path>/skills/ipc/SKILL.md</path>\\ncheck IPC\\n</skill>") throw new Error("Skill file lost in IPC");
      if (prepared.multipart.parts.length !== 6) throw new Error("Multipart context was lost");
      for (let index = 1; index < prepared.multipart.parts.length; index++) {
        await turn.onMultipartStageAcknowledged?.(index);
      }
      await turn.onSendActivated();
      turn.onSubmitted();
      turn.onHeartbeat();
      turn.onGenerationProgress();
      turn.onReasoningSummary("Reading project");
      turn.onReasoningSummary(" files", true);
      turn.onTextDelta("done");
      if (turn.captureLunaCheckpoint) turn.onLunaCheckpoint({
        answerHash: "a".repeat(64),
        checkpoint: {
          version: 1,
          objective: "Finish the helper test.",
          state: ["The answer streamed."],
          evidence: ["The helper emitted a checkpoint event."],
          decisions: [],
          pending: [],
        },
      });
      return "done";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useTemporaryChats: true,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  const checkpoints: unknown[] = [];
  const acknowledgedStages: number[] = [];
  let sendActivated = false;
  let submitted = false;
  let heartbeats = 0;
  let generationProgress = 0;
  let released = false;
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      modelFamily: "5.6",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({
        text: "inspect", images: [],
        skillFiles: [selectedSkillFile({ role: "user", origin: "codex_skill", timestamp: 0,
          content: "<skill>\n<name>ipc</name>\n<path>/skills/ipc/SKILL.md</path>\ncheck IPC\n</skill>",
        })],
        multipart: { parts: ["part one", "part two", "part three", "part four", "part five", "part six"], commit: "inspect" },
        release: () => { released = true; },
      }),
      onMultipartStageAcknowledged: stage => { acknowledgedStages.push(stage); },
      onSendActivated: () => { sendActivated = true; },
      onSubmitted: () => { submitted = true; },
      onHeartbeat: () => { heartbeats++; },
      onGenerationProgress: () => { generationProgress++; },
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onTextDelta: text => deltas.push(text),
      captureLunaCheckpoint: true,
      onLunaCheckpoint: checkpoint => checkpoints.push(checkpoint),
    });
    expect(result).toBe("done");
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(sendActivated).toBe(true);
    expect(submitted).toBe(true);
    expect(heartbeats).toBe(1);
    expect(generationProgress).toBe(1);
    expect(acknowledgedStages).toEqual([1, 2, 3, 4, 5]);
    expect(checkpoints).toEqual([{
      answerHash: "a".repeat(64),
      checkpoint: {
        version: 1,
        objective: "Finish the helper test.",
        state: ["The answer streamed."],
        evidence: ["The helper emitted a checkpoint event."],
        decisions: [],
        pending: [],
      },
    }]);
    expect(released).toBe(true);
  } finally {
    await client.close();
  }
});

test("real helper process loads large eager prompts through the private file handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-helper-file-handoff-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  const marker = "SCOREFIT_FILE_HANDOFF_MARKER";
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      const prepared = await turn.prepare();
      if (prepared.text.length < 100_000) throw new Error("Large prepared prompt was truncated");
      if (!prepared.text.includes(${JSON.stringify(marker)})) throw new Error("Large prepared prompt marker was lost");
      return "done";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  });
  const prompt = `${marker}\n` + "[company]|Markdown \\\\ payload — café\n".repeat(4_000);
  let released = false;
  try {
    await expect(client.run({
      traceId: "raw-file-process-123",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepareBeforeHelper: true,
      prepare: async () => ({ text: prompt, images: [], release: () => { released = true; } }),
      onTextDelta() {},
    })).resolves.toBe("done");
    expect(released).toBeTrue();
  } finally {
    await client.close();
  }
});

test("accepted compaction retires through the helper as completed without hiding cancellations or errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-helper-compaction-end-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    const run = ChatGptBrowserWorker.prototype.run;
    ChatGptBrowserWorker.prototype.run = function(turn) {
      // Substitute the browser wait only. Actual worker catch/finally, IPC and launcher end run.
      this.runStage = async () => {
        const stopped = new Promise((resolve, reject) => {
          turn.abortSignal.addEventListener("abort", () => reject(
            turn.traceId === "compaction_real_failure"
              ? new Error("independent browser failure")
              : new DOMException("ChatGPT web turn aborted", "AbortError")
          ), { once: true });
        });
        turn.onSubmitted();
        return stopped;
      };
      return run.call(this, turn);
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const ended = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>;
      if (body.phase === "start") return Response.json({
        ok: true, surfaceId: "launcher_surface_id_0123456789AB", reused: true, connectorBound: true,
      });
      if (body.phase === "end") ended.set(body.traceId as string, body);
      return Response.json({ ok: true, cancelledByUser: false });
    },
  });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
  }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper, browserDiagnosticsPath: join(root, "diagnostics"),
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useTemporaryChats: false,
  });
  const logs: string[] = [];
  const logger = spyOn(console, "info").mockImplementation((...args) => { logs.push(args.join(" ")); });
  try {
    for (const [traceId, reason, status] of [
      ["compaction_accepted", new ChatGptCompactionHandoffAccepted(), "completed"],
      ["compaction_cancelled", new DOMException("user cancelled", "AbortError"), "aborted"],
      ["compaction_same_text", new DOMException("Structured compaction handoff accepted", "AbortError"), "aborted"],
      ["compaction_deadline", new Error("compaction deadline exceeded"), "aborted"],
      ["compaction_real_failure", new ChatGptCompactionHandoffAccepted(), "failed"],
    ] as const) {
      const controller = new AbortController();
      let released = false;
      const prepare = async () => ({ text: "checkpoint instruction", images: [], release: () => { released = true; } });
      await expect(client.run({
        traceId, modelId: "gpt-5.6-sol", reasoning: "high",
        capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
        nativeConnector: true, conversationKey: "a".repeat(64), requireRetainedConversation: true,
        prepare, prepareResume: prepare, abortSignal: controller.signal,
        onSubmitted: () => { controller.abort(reason); }, onTextDelta() {},
      })).rejects.toThrow(traceId === "compaction_real_failure"
        ? "independent browser failure"
        : traceId === "compaction_accepted" ? "Structured compaction handoff accepted" : "ChatGPT web turn aborted");
      // Logical outcome is observed only after the real helper's launcher retirement handshake.
      expect(ended.get(traceId)?.status).toBe(status);
      expect(ended.get(traceId)?.retain).toBeUndefined();
      expect(released).toBeTrue();
    }
    await client.close();
    expect(logs.some(line => line.includes("compaction_accepted ended after accepted structured compaction handoff"))).toBeTrue();
    expect(logs.some(line => line.includes("compaction_accepted failed:"))).toBeFalse();
    for (const traceId of ["compaction_cancelled", "compaction_same_text", "compaction_deadline", "compaction_real_failure"]) {
      expect(logs.some(line => line.includes(`${traceId} failed:`))).toBeTrue();
    }
  } finally {
    await client.close();
    logger.mockRestore();
    await server.stop(true);
  }
});

test("launcher helper protocol preserves multipart context, broker identity and the compaction flag", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2 DEV",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useTemporaryChats: false,
  });
  const internal = client as unknown as {
    pending: Map<string, { resolve(value: string): void }>;
    child?: unknown;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    finish(id: string): void;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  internal.send = async message => {
    sent.push(message);
    if (typeof message.id !== "string") return;
    if (message.type === "run") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "event",
        id: message.id,
        event: "prepared_selected",
        reused: false,
      })));
    } else if (message.type === "prepared_selected_ack") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "result",
        id: message.id,
        text: "done",
      })));
    }
  };

  await expect(client.run({
    traceId: "multipart-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    compaction: true,
    prepare: async () => ({
      text: "commit",
      images: [],
      turnToken: "turn_0123456789abcdef0123456789abcdef",
      multipart: { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "commit" },
      trimmedCompactionMessages: 4,
      contextTokenBreakdown: { developer: { records: 1, chars: 400, tokens: 100 } },
      release() {},
    }),
    onTextDelta() {},
  })).resolves.toBe("done");

  expect(sent[0]).toMatchObject({
    type: "run",
    turn: {
      compaction: true,
    },
  });
  expect(sent[1]).toMatchObject({
    type: "prepared_selected_ack",
    prepared: {
        text: "commit",
        turnToken: "turn_0123456789abcdef0123456789abcdef",
        multipart: { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "commit" },
        trimmedCompactionMessages: 4,
        contextTokenBreakdown: { developer: { records: 1, chars: 400, tokens: 100 } },
    },
  });
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useTemporaryChats: false,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(false);
});

test("one-shot prepared prompts require the helper to acknowledge the initial run frame", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  });
  const internal = client as unknown as {
    child: unknown;
    helperFeatures: Set<string>;
    ensureChild(): Promise<void>;
    send(message: Record<string, any>): Promise<void>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.helperFeatures = new Set(["prepared-run-prompt", "run-accepted"]);
  internal.ensureChild = async () => {};
  const sent: Record<string, any>[] = [];
  internal.send = async message => {
    sent.push(message);
    if (message.type === "run") queueMicrotask(() => {
      internal.handleLine(child, JSON.stringify({
        type: "event",
        id: message.id,
        event: "run_accepted",
      }));
      internal.handleLine(child, JSON.stringify({
        type: "result",
        id: message.id,
        text: "done",
      }));
    });
  };
  let prepareCalls = 0;
  let released = false;

  await expect(client.run({
    traceId: "raw-prepared-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepareBeforeHelper: true,
    prepare: async () => {
      prepareCalls += 1;
      return { text: "# Master prompt\n\nCompany input", images: [], release: () => { released = true; } };
    },
    onTextDelta: () => {},
  })).resolves.toBe("done");

  expect(prepareCalls).toBe(1);
  expect(released).toBeTrue();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "run",
    id: "raw-prepared-123",
    prepared: { text: "# Master prompt\n\nCompany input", images: [] },
  });
});

test("large one-shot prepared prompts use a private file-backed helper handoff", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  });
  const internal = client as unknown as {
    child: unknown;
    helperFeatures: Set<string>;
    ensureChild(): Promise<void>;
    send(message: Record<string, any>): Promise<void>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.helperFeatures = new Set(["prepared-run-prompt", "prepared-run-file", "run-accepted"]);
  internal.ensureChild = async () => {};
  const prompt = "# Master prompt\n\n" + "Company | markdown \\\\ data — café\n".repeat(4_000);
  let preparedPath = "";
  let observedText = "";
  internal.send = async message => {
    if (message.type !== "run") return;
    expect(message.prepared).toBeUndefined();
    expect(message.preparedFile?.bytes).toBeGreaterThan(32 * 1024);
    preparedPath = message.preparedFile.path;
    const prepared = JSON.parse(readFileSync(preparedPath, "utf8"));
    observedText = prepared.text;
    queueMicrotask(() => {
      internal.handleLine(child, JSON.stringify({ type: "event", id: message.id, event: "run_accepted" }));
      internal.handleLine(child, JSON.stringify({ type: "result", id: message.id, text: "done" }));
    });
  };

  await expect(client.run({
    traceId: "raw-file-prepared-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepareBeforeHelper: true,
    prepare: async () => ({ text: prompt, images: [], release() {} }),
    onTextDelta() {},
  })).resolves.toBe("done");

  expect(observedText).toBe(prompt);
  expect(preparedPath).not.toBe("");
  expect(existsSync(preparedPath)).toBeFalse();
});

test("an unacknowledged prepared run fails fast as retryable instead of hanging", async () => {
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  };
  const client = new LauncherBrowserHelperClient(config, 20);
  const internal = client as unknown as {
    child: unknown;
    helperFeatures: Set<string>;
    ensureChild(): Promise<void>;
    send(message: Record<string, any>): Promise<void>;
  };
  internal.child = {};
  internal.helperFeatures = new Set(["prepared-run-prompt", "run-accepted"]);
  internal.ensureChild = async () => {};
  internal.send = async () => {};

  await expect(client.run({
    traceId: "raw-unacked-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepareBeforeHelper: true,
    prepare: async () => ({ text: "score companies", images: [], release() {} }),
    onTextDelta() {},
  })).rejects.toMatchObject({
    status: 503,
    code: "browser_helper_start_timeout",
    retryable: true,
  });
});

test("structured helper errors preserve the ChatGPT adapter failure contract", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useTemporaryChats: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("rate-limit-123", {
      turn: {
        traceId: "rate-limit-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
      },
      resolve: resolveResult,
      reject: rejectResult,
    });
  });

  internal.handleLine(child, JSON.stringify({
    type: "error",
    id: "rate-limit-123",
    name: "ChatGptWebAdapterError",
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  }));

  const error = await result.then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
});

test("an older helper cannot silently drop selected skill files and releases the prepared turn", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused.json", chromeExecutablePath: "/durable/chrome", headed: true, autoApproveToolCalls: false, useTemporaryChats: false,
  });
  const internal = client as unknown as {
    child: unknown;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  const sent: string[] = [];
  internal.send = async message => {
    sent.push(String(message.type));
    if (message.type === "run") queueMicrotask(() => internal.handleLine(child, JSON.stringify({
      type: "event", id: message.id, event: "prepared_selected", reused: false,
    })));
    if (message.type === "abort") queueMicrotask(() => internal.handleLine(child, JSON.stringify({
      type: "error", id: message.id, message: "aborted",
    })));
  };
  let released = false;
  await expect(client.run({
    traceId: "skill-old-helper", modelId: "gpt-5.6-sol", reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "inspect", images: [],
      skillFiles: [selectedSkillFile({ role: "user", origin: "codex_skill", timestamp: 0,
        content: "<skill>\n<name>test</name>\n<path>/test</path>\ncheck\n</skill>",
      })],
      release() { released = true; },
    }),
    onTextDelta() {},
  })).rejects.toThrow("does not support skill attachments");
  expect(sent).toEqual(["run", "abort"]);
  expect(released).toBe(true);
});
