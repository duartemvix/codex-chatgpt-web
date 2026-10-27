import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { BrowserTurn, ResolvedBrowserConfig } from "./browser-worker";
import {
  parseChatGptLunaCheckpoint,
  type ChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

interface PendingTurn {
  turn: BrowserTurn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
  sent?: boolean;
  prepared?: CompiledChatGptWebPrompt & { release: () => void };
  localFailure?: Error;
  progressForwarding?: AbortController;
  acknowledgedMultipartStage?: number;
  runAccepted?: boolean;
  runAcceptanceTimer?: ReturnType<typeof setTimeout>;
  preparedRunTempDir?: string;
}

const PREPARED_RUN_FILE_THRESHOLD_BYTES = 32 * 1024;

interface PreparedRunFile {
  path: string;
  bytes: number;
  sha256: string;
}

type HelperMessage =
  | { type: "ready"; features?: string[] }
  | { type: "event"; id: string; event: "run_accepted" }
  | { type: "event"; id: string; event: "heartbeat" | "generation_progress" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text"; text?: string; continuation?: boolean }
  | { type: "event"; id: string; event: "tool_batch_observed"; revision: number }
  | { type: "event"; id: string; event: "multipart_stage_acknowledged"; stageIndex: number }
  | { type: "event"; id: string; event: "completion_fence_begin"; requestId: number }
  | { type: "event"; id: string; event: "completion_fence_commit"; requestId: number; revision: number }
  | { type: "event"; id: string; event: "prepared_selected"; reused: boolean }
  | { type: "event"; id: string; event: "luna_checkpoint"; checkpoint: ChatGptLunaCheckpoint; answerHash: string }
  | { type: "result"; id: string; text: string }
  | {
      type: "error";
      id: string;
      name?: string;
      message: string;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
    };

function parseHelperMessage(line: string): HelperMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type === "ready") {
    const features = message.features;
    if (features !== undefined
      && (!Array.isArray(features) || features.some(feature => typeof feature !== "string"))) {
      throw new Error("Launcher browser helper advertised invalid features");
    }
    return { type: "ready", ...(features ? { features: features as string[] } : {}) };
  }
  if (typeof message.id !== "string" || !message.id) {
    throw new Error("Launcher browser helper message has no turn identity");
  }
  if (message.type === "event") {
    const event = message.event;
    if (event === "multipart_stage_acknowledged") {
      if (!Number.isSafeInteger(message.stageIndex) || (message.stageIndex as number) <= 0) {
        throw new Error("Launcher browser helper multipart stage index is invalid");
      }
      return { type: "event", id: message.id, event, stageIndex: message.stageIndex as number };
    }
    if (event === "tool_batch_observed") {
      if (!Number.isSafeInteger(message.revision) || (message.revision as number) <= 0) {
        throw new Error("Launcher browser helper tool-boundary revision is invalid");
      }
      return { type: "event", id: message.id, event, revision: message.revision as number };
    }
    if (event === "completion_fence_begin") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0) {
        throw new Error("Launcher browser helper completion fence request id is invalid");
      }
      return { type: "event", id: message.id, event, requestId: message.requestId as number };
    }
    if (event === "completion_fence_commit") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0
        || !Number.isSafeInteger(message.revision) || (message.revision as number) < 0) {
        throw new Error("Launcher browser helper completion fence revision is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        requestId: message.requestId as number,
        revision: message.revision as number,
      };
    }
    if (event === "luna_checkpoint") {
      if (typeof message.answerHash !== "string" || !/^[a-f0-9]{64}$/.test(message.answerHash)) {
        throw new Error("Launcher browser helper Luna checkpoint answer hash is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        checkpoint: parseChatGptLunaCheckpoint(message.checkpoint),
        answerHash: message.answerHash,
      };
    }
    const text = message.text;
    const continuation = message.continuation;
    if (event === "prepared_selected") {
      if (typeof message.reused !== "boolean") {
        throw new Error("Launcher browser helper prompt selection is invalid");
      }
      return { type: "event", id: message.id, event, reused: message.reused };
    }
    if (event === "run_accepted") {
      return { type: "event", id: message.id, event };
    }
    if (!["heartbeat", "generation_progress", "send_activated", "submitted", "reasoning", "commentary", "text"].includes(String(event))) {
      throw new Error("Launcher browser helper emitted an unknown event");
    }
    if (text !== undefined && typeof text !== "string") {
      throw new Error("Launcher browser helper event text is invalid");
    }
    if (continuation !== undefined && typeof continuation !== "boolean") {
      throw new Error("Launcher browser helper continuation flag is invalid");
    }
    return {
      type: "event",
      id: message.id,
      event: event as "heartbeat" | "generation_progress" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text",
      ...(text !== undefined ? { text: text as string } : {}),
      ...(continuation !== undefined ? { continuation: continuation as boolean } : {}),
    };
  }
  if (message.type === "result") {
    const text = message.text;
    if (typeof text !== "string") {
      throw new Error("Launcher browser helper result text is invalid");
    }
    return { type: "result", id: message.id, text };
  }
  if (message.type === "error") {
    const errorMessage = message.message;
    const errorName = message.name;
    const status = message.status;
    const errorType = message.errorType;
    const code = message.code;
    const retryable = message.retryable;
    const structured = status !== undefined
      || errorType !== undefined
      || code !== undefined
      || retryable !== undefined;
    if (typeof errorMessage !== "string"
      || (errorName !== undefined && typeof errorName !== "string")
      || (structured && (
        !Number.isInteger(status)
        || (status as number) < 400
        || (status as number) > 599
        || typeof errorType !== "string"
        || !errorType
        || typeof code !== "string"
        || !code
        || typeof retryable !== "boolean"
      ))) {
      throw new Error("Launcher browser helper error payload is invalid");
    }
    return {
      type: "error",
      id: message.id,
      message: errorMessage,
      ...(errorName !== undefined ? { name: errorName as string } : {}),
      ...(structured ? {
        status: status as number,
        errorType: errorType as string,
        code: code as string,
        retryable: retryable as boolean,
      } : {}),
    };
  }
  throw new Error("Launcher browser helper emitted an unknown message type");
}

export class LauncherBrowserHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly pending = new Map<string, PendingTurn>();
  private helperFeatures = new Set<string>();

  constructor(
    private readonly config: ResolvedBrowserConfig,
    private readonly runAcceptanceTimeoutMs = 5_000,
  ) {}

  /**
   * The helper that shipped with this daemon, when one sits beside its own entrypoint.
   *
   * The launcher advertises the helper inside its application bundle while the daemon runs from a
   * versioned runtime directory, so the two sides update independently and can disagree about the
   * protocol. Preferring the sibling keeps daemon and helper on the same build by construction;
   * anything else — a source checkout, an unbundled entrypoint — falls back to the advertised path.
   */
  private bundledHelperScript(): string | undefined {
    const entrypoint = process.argv[1];
    // Only the packaged runtime layout is claimed: the bundle builder emits cli.js and
    // browser-helper.cjs into one directory. Matching on that entrypoint name keeps a source
    // checkout, or any other launch shape, on the launcher-advertised helper rather than adopting
    // an unrelated sibling that merely shares a filename.
    if (typeof entrypoint !== "string" || basename(entrypoint) !== "cli.js") return undefined;
    const sibling = join(dirname(entrypoint), "browser-helper.cjs");
    return existsSync(sibling) ? sibling : undefined;
  }

  async run(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    console.info(`[chatgpt-web-helper-client] run begin trace=${turn.traceId}`);
    await this.ensureChild();
    console.info(`[chatgpt-web-helper-client] helper ready trace=${turn.traceId} pid=${this.child?.pid ?? "none"}`);
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (turn.prepareBeforeHelper && !this.helperFeatures.has("prepared-run-prompt")) {
      throw new Error(
        "Launcher browser helper does not support prepared prompts in the initial run frame; update or restart the launcher",
      );
    }
    if (turn.prepareBeforeHelper && turn.prepareResume) {
      throw new Error("Launcher eager prompt preparation cannot be combined with retained-conversation continuation");
    }
    if (turn.onMultipartStageAcknowledged && !this.helperFeatures.has("multipart-stage-ack")) {
      throw new Error(
        "Launcher browser helper does not support multipart acknowledgement forwarding; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("tool-boundary-ack")) {
      throw new Error(
        "Launcher browser helper does not support causal Codex tool-boundary acknowledgement; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("completion-fence")) {
      throw new Error(
        "Launcher browser helper does not support the MCP completion fence; update or restart the launcher",
      );
    }
    if (turn.preferClipboardPaste && !this.helperFeatures.has("clipboard-paste")) {
      throw new Error(
        "Launcher browser helper does not support native clipboard prompt paste; update or restart the launcher",
      );
    }
    const preparedBeforeHelper = turn.prepareBeforeHelper ? await turn.prepare() : undefined;
    if (turn.abortSignal?.aborted) {
      preparedBeforeHelper?.release();
      throw new DOMException("ChatGPT web turn aborted", "AbortError");
    }
    let preparedRunFile: PreparedRunFile | undefined;
    let preparedRunTempDir: string | undefined;
    if (preparedBeforeHelper) {
      const serialized = JSON.stringify({
        text: preparedBeforeHelper.text,
        images: preparedBeforeHelper.images,
        ...(preparedBeforeHelper.turnToken ? { turnToken: preparedBeforeHelper.turnToken } : {}),
        ...(preparedBeforeHelper.skillFiles ? { skillFiles: preparedBeforeHelper.skillFiles } : {}),
        ...(preparedBeforeHelper.multipart ? { multipart: preparedBeforeHelper.multipart } : {}),
        ...(preparedBeforeHelper.trimmedCompactionMessages !== undefined
          ? { trimmedCompactionMessages: preparedBeforeHelper.trimmedCompactionMessages }
          : {}),
      } satisfies CompiledChatGptWebPrompt);
      const bytes = Buffer.byteLength(serialized);
      if (bytes >= PREPARED_RUN_FILE_THRESHOLD_BYTES) {
        if (!this.helperFeatures.has("prepared-run-file")) {
          preparedBeforeHelper.release();
          throw new Error(
            "Launcher browser helper does not support file-backed prepared prompts; update or restart the launcher",
          );
        }
        preparedRunTempDir = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-prepared-"));
        const path = join(preparedRunTempDir, "prompt.json");
        writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
        preparedRunFile = {
          path,
          bytes,
          sha256: createHash("sha256").update(serialized).digest("hex"),
        };
      }
    }
    return await new Promise<string>((resolveResult, rejectResult) => {
        if (this.pending.has(turn.traceId)) {
          if (preparedRunTempDir) rmSync(preparedRunTempDir, { recursive: true, force: true });
          preparedBeforeHelper?.release();
          rejectResult(new Error(`Duplicate launcher browser turn: ${turn.traceId}`));
          return;
        }
        const pending: PendingTurn = {
          turn,
          resolve: resolveResult,
          reject: rejectResult,
          ...(preparedBeforeHelper ? { prepared: preparedBeforeHelper } : {}),
          ...(preparedRunTempDir ? { preparedRunTempDir } : {}),
        };
        this.pending.set(turn.traceId, pending);
        if (turn.abortSignal) {
          const abortListener = () => {
            if (!pending.sent) {
              this.finishWithError(
                turn.traceId,
                new DOMException("ChatGPT web turn aborted", "AbortError"),
              );
              return;
            }
            void this.send({
              type: "abort",
              id: turn.traceId,
              ...(turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted
                ? { reason: "compaction_handoff_accepted" }
                : {}),
            }).catch(error => {
              this.finishWithError(
                turn.traceId,
                error instanceof Error ? error : new Error(String(error)),
              );
            });
          };
          pending.abortListener = abortListener;
          turn.abortSignal.addEventListener("abort", abortListener, { once: true });
          if (turn.abortSignal.aborted) {
            abortListener();
            return;
          }
        }
        // Setting this before the synchronous write call makes an abort either prevent dispatch or
        // queue an `abort` after the `run` frame; it can never overtake the run frame in the pipe.
        pending.sent = true;
        const progressForwarding = new AbortController();
        pending.progressForwarding = progressForwarding;
        console.info(
          `[chatgpt-web-helper-client] dispatch trace=${turn.traceId} pid=${this.child?.pid ?? "none"}`
          + ` preparedChars=${preparedBeforeHelper?.text.length ?? 0}`,
        );
        void this.send({
          type: "run",
          id: turn.traceId,
          config: {
            appName: this.config.appName,
            browserHostDescriptorPath: this.config.browserHostDescriptorPath!,
            browserDiagnosticsPath: this.config.browserDiagnosticsPath,
            turnTimeoutMs: this.config.turnTimeoutMs,
            autoApproveToolCalls: this.config.autoApproveToolCalls,
            useTemporaryChats: this.config.useTemporaryChats,
          },
          turn: {
            traceId: turn.traceId,
            modelId: turn.modelId,
            reasoning: turn.reasoning,
            ...(turn.modelFamily ? { modelFamily: turn.modelFamily } : {}),
            capabilities: turn.capabilities,
            ...(turn.nativeConnector ? { nativeConnector: true } : {}),
            ...(turn.prepareResume ? { resumeAvailable: true } : {}),
            ...(turn.retainConversation ? { retainConversation: true } : {}),
            ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
            ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
            ...(turn.compaction ? { compaction: true } : {}),
            ...(turn.captureLunaCheckpoint ? { captureLunaCheckpoint: true } : {}),
            ...(turn.externalProgress ? { externalProgress: true } : {}),
            ...(turn.allowCompletionWithoutAction ? { allowCompletionWithoutAction: true } : {}),
            ...(turn.preferClipboardPaste ? { preferClipboardPaste: true } : {}),
          },
          ...(preparedRunFile ? { preparedFile: preparedRunFile } : preparedBeforeHelper ? {
            prepared: {
              text: preparedBeforeHelper.text,
              images: preparedBeforeHelper.images,
              ...(preparedBeforeHelper.turnToken ? { turnToken: preparedBeforeHelper.turnToken } : {}),
              ...(preparedBeforeHelper.skillFiles ? { skillFiles: preparedBeforeHelper.skillFiles } : {}),
              ...(preparedBeforeHelper.multipart ? { multipart: preparedBeforeHelper.multipart } : {}),
              ...(preparedBeforeHelper.trimmedCompactionMessages !== undefined
                ? { trimmedCompactionMessages: preparedBeforeHelper.trimmedCompactionMessages }
                : {}),
            } satisfies CompiledChatGptWebPrompt,
          } : {}),
        })
          // Only mirror once the run frame is on the wire, so the helper never sees progress for a
          // turn it has not been told about and cannot accumulate state for unknown ids.
          .then(() => {
            console.info(`[chatgpt-web-helper-client] dispatch written trace=${turn.traceId} pid=${this.child?.pid ?? "none"}`);
            if (this.helperFeatures.has("run-accepted")
              && this.pending.get(turn.traceId) === pending
              && !pending.runAccepted) {
              pending.runAcceptanceTimer = setTimeout(() => {
                if (this.pending.get(turn.traceId) !== pending || pending.runAccepted) return;
                console.warn(
                  `[chatgpt-web-helper-client] run acknowledgement timed out trace=${turn.traceId}`
                  + ` pid=${this.child?.pid ?? "none"} timeoutMs=${this.runAcceptanceTimeoutMs}`,
                );
                this.finishWithError(turn.traceId, new ChatGptWebAdapterError(
                  `Launcher browser helper did not acknowledge the run frame within ${this.runAcceptanceTimeoutMs}ms`,
                  {
                    status: 503,
                    errorType: "server_error",
                    code: "browser_helper_start_timeout",
                    retryable: true,
                  },
                ));
              }, this.runAcceptanceTimeoutMs);
              pending.runAcceptanceTimer.unref?.();
            }
            if (!progressForwarding.signal.aborted) this.forwardProgress(turn, progressForwarding.signal);
          })
          .catch(error => this.finishWithError(turn.traceId, error instanceof Error ? error : new Error(String(error))));
      });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const id of [...this.pending.keys()]) {
      this.finishWithError(id, new DOMException("Launcher browser helper is closing", "AbortError"));
    }
    if (!child) return;
    await this.sendTo(child, { type: "shutdown" }).catch(() => {});
    await this.terminateChild(child, 2_000);
  }

  private async ensureChild(): Promise<void> {
    if (this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.ready) {
      console.info(`[chatgpt-web-helper-client] reuse helper pid=${this.child.pid ?? "none"}`);
      return this.ready;
    }
    const descriptor = readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!);
    const child = spawn(
      descriptor.helper.executable,
      [this.config.browserHelperScriptPath ?? this.bundledHelperScript() ?? descriptor.helper.script],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    console.info(`[chatgpt-web-helper-client] spawned helper pid=${child.pid ?? "none"}`);
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const output = createInterface({ input: child.stdout });
    output.on("line", line => this.handleLine(child, line));
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => console.info(`[chatgpt-web-helper] ${line}`));
    const failChild = (error: Error) => {
      const owned = this.child === child;
      this.handleExit(child, error);
      if (owned && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
        void this.terminateChild(child, 0).catch(cleanupError => {
          console.error(
            `[chatgpt-web-helper] process-error cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
      }
    };
    child.once("error", failChild);
    child.stdin.once("error", error => failChild(new Error(
      `Launcher browser helper input failed: ${error instanceof Error ? error.message : String(error)}`,
    )));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(
      `Launcher browser helper exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
    )));
    const timer = setTimeout(() => {
      if (this.child === child) this.readyReject?.(new Error("Launcher browser helper did not become ready"));
    }, 15_000);
    try {
      await this.ready;
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
      try {
        await this.terminateChild(child, 500);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; launcher browser helper cleanup failed: ${cleanup}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: HelperMessage;
    try { message = parseHelperMessage(line); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleExit(child, new Error(`Launcher browser helper emitted invalid protocol data: ${detail}`));
      void this.terminateChild(child, 0).catch(error => {
        console.error(`[chatgpt-web-helper] invalid-protocol cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (message.type === "ready") {
      // Optional frames are sent only when the helper advertises support for them.
      this.helperFeatures = new Set(message.features ?? []);
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      if (message.event === "run_accepted") {
        pending.runAccepted = true;
        if (pending.runAcceptanceTimer) clearTimeout(pending.runAcceptanceTimer);
        pending.runAcceptanceTimer = undefined;
        if (pending.preparedRunTempDir) {
          rmSync(pending.preparedRunTempDir, { recursive: true, force: true });
          pending.preparedRunTempDir = undefined;
        }
        console.info(`[chatgpt-web-helper-client] run accepted trace=${message.id} pid=${child.pid ?? "none"}`);
      } else if (message.event === "heartbeat") pending.turn.onHeartbeat?.();
      else if (message.event === "generation_progress") pending.turn.onGenerationProgress?.();
      else if (message.event === "tool_batch_observed") {
        const progress = pending.turn.externalProgress;
        if (!progress) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper observed a tool boundary for a turn without progress transport"),
            pending,
          );
          return;
        }
        void progress.acknowledgeToolBatch(message.revision).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_begin") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.begin().then(revision => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_begin_ack",
            id: message.id,
            requestId: message.requestId,
            revision: revision ?? null,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_commit") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.commit(message.revision).then(committed => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_commit_ack",
            id: message.id,
            requestId: message.requestId,
            committed,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "send_activated") {
        void Promise.resolve().then(() => pending.turn.onSendActivated?.()).then(() => {
          if (this.pending.get(message.id) !== pending) return;
          return this.send({ type: "send_activation_ack", id: message.id });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "submitted") pending.turn.onSubmitted?.();
      else if (message.event === "multipart_stage_acknowledged") {
        const multipart = pending.prepared?.multipart;
        if (!multipart
          || message.stageIndex >= multipart.parts.length
          || message.stageIndex !== (pending.acknowledgedMultipartStage ?? 0) + 1) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper acknowledged an unexpected multipart stage"),
            pending,
          );
          return;
        }
        pending.acknowledgedMultipartStage = message.stageIndex;
        void Promise.resolve().then(() => pending.turn.onMultipartStageAcknowledged?.(message.stageIndex))
          .catch(error => this.abortWithLocalFailure(
            message.id,
            error instanceof Error ? error : new Error(String(error)),
            pending,
          ));
      }
      else if (message.event === "prepared_selected") {
        const prepare = message.reused ? pending.turn.prepareResume : pending.turn.prepare;
        void Promise.resolve().then(() => prepare?.()).then(prepared => {
          if (!prepared) throw new Error("Launcher browser helper selected an unavailable continuation prompt");
          if (this.pending.get(message.id) !== pending) {
            prepared.release();
            return;
          }
          pending.prepared = prepared;
          if (prepared.skillFiles?.length && !this.helperFeatures.has("skill-attachments")) {
            throw new Error("Launcher browser helper does not support skill attachments; update or restart the launcher");
          }
          return Promise.resolve(pending.turn.onPreparedSelected?.(message.reused)).then(() => {
            if (this.pending.get(message.id) !== pending) return;
            return this.send({
              type: "prepared_selected_ack",
              id: message.id,
              prepared: {
                text: prepared.text,
                images: prepared.images,
                ...(prepared.turnToken ? { turnToken: prepared.turnToken } : {}),
                ...(prepared.skillFiles ? { skillFiles: prepared.skillFiles } : {}),
                ...(prepared.multipart ? { multipart: prepared.multipart } : {}),
                ...(prepared.contextTokenBreakdown ? { contextTokenBreakdown: prepared.contextTokenBreakdown } : {}),
                ...(prepared.trimmedCompactionMessages !== undefined
                  ? { trimmedCompactionMessages: prepared.trimmedCompactionMessages }
                  : {}),
              } satisfies CompiledChatGptWebPrompt,
            });
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "luna_checkpoint") {
        if (!pending.turn.captureLunaCheckpoint || !pending.turn.onLunaCheckpoint) {
          this.finishWithError(message.id, new Error("Launcher browser helper emitted an unexpected Luna checkpoint"));
          return;
        }
        pending.turn.onLunaCheckpoint({ checkpoint: message.checkpoint, answerHash: message.answerHash });
      }
      else if (message.event === "reasoning" && message.text) {
        pending.turn.onReasoningSummary?.(message.text, message.continuation === true);
      }
      else if (message.event === "commentary" && message.text) pending.turn.onCommentary?.(message.text, message.continuation === true);
      else if (message.event === "text" && message.text) pending.turn.onTextDelta(message.text);
      return;
    }
    if (message.type === "result") {
      console.info(`[chatgpt-web-helper-client] result trace=${message.id} pid=${child.pid ?? "none"}`);
      this.finish(message.id);
      if (pending.localFailure) pending.reject(pending.localFailure);
      else pending.resolve(message.text);
    } else if (message.type === "error") {
      console.info(`[chatgpt-web-helper-client] error trace=${message.id} pid=${child.pid ?? "none"} message=${message.message}`);
      const error = message.status !== undefined
        ? new ChatGptWebAdapterError(message.message, {
          status: message.status,
          errorType: message.errorType!,
          code: message.code!,
          retryable: message.retryable!,
        })
        : message.name === "AbortError"
          ? new DOMException(message.message, "AbortError")
          : new Error(message.message);
      this.finish(message.id);
      pending.reject(pending.localFailure ?? error);
    }
  }

  private abortWithLocalFailure(id: string, error: Error, pending: PendingTurn): void {
    if (this.pending.get(id) !== pending || pending.localFailure) return;
    pending.localFailure = error;
    void this.send({ type: "abort", id }).catch(sendError => {
      if (this.pending.get(id) !== pending) return;
      this.finishWithError(
        id,
        new AggregateError(
          [error, sendError instanceof Error ? sendError : new Error(String(sendError))],
          "Launcher browser helper could not abort after a local protocol failure",
        ),
      );
    });
  }

  /**
   * Mirrors daemon-recorded MCP progress into the helper process for the life of the turn.
   *
   * The browser worker runs out of process, so without this the worker sees no external progress
   * and cancels turns whose tool calls are still completing.
   */
  private forwardProgress(turn: BrowserTurn, stop: AbortSignal): void {
    const progress = turn.externalProgress;
    if (!progress) return;
    if (!this.helperFeatures.has("progress")) {
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} runs without an MCP progress mirror:`
        + " the launcher browser helper predates the progress frame",
      );
      return;
    }
    void (async () => {
      let revision = 0;
      while (!stop.aborted) {
        const snapshot = await progress.waitForChange(revision, stop);
        revision = snapshot.revision;
        if (stop.aborted) return;
        await this.send({ type: "progress", id: turn.traceId, snapshot });
      }
    })().catch(error => {
      // Ending, aborting, or losing the helper stops the mirror by design and is not a fault.
      // Anything else leaves the worker on DOM-only health without saying so, which is exactly the
      // silent degradation this transport exists to remove, so it is surfaced rather than dropped.
      if (stop.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} lost its MCP progress mirror:`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.runAcceptanceTimer) clearTimeout(pending.runAcceptanceTimer);
    pending.runAcceptanceTimer = undefined;
    if (pending.preparedRunTempDir) {
      rmSync(pending.preparedRunTempDir, { recursive: true, force: true });
      pending.preparedRunTempDir = undefined;
    }
    if (pending.abortListener && pending.turn.abortSignal) {
      pending.turn.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    pending.progressForwarding?.abort();
    pending.progressForwarding = undefined;
    pending.prepared?.release();
    pending.prepared = undefined;
    this.pending.delete(id);
  }

  private finishWithError(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.finish(id);
    pending.reject(error);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    this.ready = undefined;
    this.child = undefined;
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "end",
        traceId: id,
        helperPid: child.pid!,
        status: "failed",
        message: "Launcher browser helper exited before completing the turn",
      }).then(
        () => this.finishWithError(id, pending.localFailure ?? error),
        controlError => this.finishWithError(
          id,
          new AggregateError(
            [pending.localFailure ?? error, controlError instanceof Error ? controlError : new Error(String(controlError))],
            `Launcher browser helper exited and failed to release turn ${id}`,
          ),
        ),
      );
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>(resolveExit => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams, gracefulTimeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (await this.waitForExit(child, gracefulTimeoutMs)) return;
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused termination");
    }
    if (await this.waitForExit(child, 2_000)) return;
    if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused forced termination");
    }
    if (!await this.waitForExit(child, 2_000)) {
      throw new Error("Launcher browser helper did not exit after forced termination");
    }
  }

  private send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child
      || child.killed
      || child.exitCode !== null
      || child.signalCode !== null) {
      return Promise.reject(new Error("Launcher browser helper is not running"));
    }
    return this.sendTo(child, message);
  }

  private async sendTo(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Launcher browser helper input is closed");
    }
    const meta = message && typeof message === "object" && !Array.isArray(message)
      ? message as { type?: unknown; id?: unknown }
      : {};
    console.info(
      `[chatgpt-web-helper-client] write begin pid=${child.pid ?? "none"}`
      + ` type=${typeof meta.type === "string" ? meta.type : "unknown"}`
      + ` id=${typeof meta.id === "string" ? meta.id : "none"}`
      + ` bytes=${Buffer.byteLength(encoded)}`,
    );
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(encoded, error => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
    console.info(
      `[chatgpt-web-helper-client] write done pid=${child.pid ?? "none"}`
      + ` type=${typeof meta.type === "string" ? meta.type : "unknown"}`
      + ` id=${typeof meta.id === "string" ? meta.id : "none"}`,
    );
  }
}
