import { randomUUID } from "node:crypto";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "./adapters/chatgpt-web/browser-worker";
import { formatErrorResponse } from "./bridge";
import { requireChatGptWebModelRoute } from "./chatgpt-web-models";
import { providerConfig, type AppConfig } from "./config";
import { readJsonRequestBody } from "./http-body";
import type { CodexProviderConfig } from "./types";

interface BrowserResponsesWorker {
  run(turn: BrowserTurn): Promise<string>;
  close?(): Promise<void>;
}

export type BrowserResponsesWorkerFactory = (provider: CodexProviderConfig) => BrowserResponsesWorker;

const defaultWorkerFactory: BrowserResponsesWorkerFactory = provider => (
  ChatGptBrowserWorker.createIsolated(provider)
);

function requestedReasoning(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const effort = (value as { effort?: unknown }).effort;
    if (typeof effort === "string") return effort;
  }
  return undefined;
}

function adapterErrorResponse(error: ChatGptWebAdapterError): Response {
  return Response.json({
    error: {
      type: error.errorType,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  }, { status: error.status });
}

/**
 * Raw, single-turn ChatGPT Web inference for local workflow clients.
 *
 * This deliberately bypasses the native Codex request parser and prompt compiler. The exact
 * input string becomes the ChatGPT user message, with no Codex history, environment, tools,
 * compaction metadata, or continuation state attached.
 */
export async function browserResponsesRequest(
  req: Request,
  config: AppConfig,
  workerFactory: BrowserResponsesWorkerFactory = defaultWorkerFactory,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return formatErrorResponse(400, "invalid_request_error", "Request body must be a JSON object");
  }
  const body = raw as { model?: unknown; input?: unknown; reasoning?: unknown; stream?: unknown };
  if (typeof body.model !== "string" || !body.model.trim()) {
    return formatErrorResponse(400, "invalid_request_error", "model must be a non-empty string");
  }
  if (typeof body.input !== "string" || !body.input.trim()) {
    return formatErrorResponse(400, "invalid_request_error", "input must be a non-empty string");
  }
  if (body.stream !== undefined && body.stream !== false) {
    return formatErrorResponse(400, "invalid_request_error", "browser responses do not support streaming");
  }
  const reasoning = requestedReasoning(body.reasoning);
  if (body.reasoning !== undefined && reasoning === undefined) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "reasoning must be an effort string or an object with a string effort field",
    );
  }

  try {
    const route = requireChatGptWebModelRoute(body.model, config, reasoning);
    if (route.interactionMode !== "automatic") {
      return formatErrorResponse(
        409,
        "invalid_request_error",
        "Raw browser responses require automatic ChatGPT Web interaction",
      );
    }

    const provider = providerConfig(config);
    if (!provider.chatgptWeb) throw new Error("ChatGPT Web provider configuration is unavailable");
    provider.chatgptWeb = {
      ...provider.chatgptWeb,
      localToolsEnabled: false,
      useTemporaryChats: true,
    };
    const worker = workerFactory(provider);
    const traceId = `browser_${randomUUID().replaceAll("-", "")}`;
    const startedAt = Date.now();
    console.info(
      `[browser-responses] dispatch trace=${traceId} model=${route.slug} inputChars=${(body.input as string).length}`,
    );
    let answer: string;
    try {
      answer = await worker.run({
      traceId,
      modelId: route.backendModel,
      reasoning: route.adapterEffort,
      modelFamily: route.modelFamily,
      capabilities: {
        localToolsEnabled: false,
        solAvailable: config.solAvailable,
        extraHighAvailable: config.extraHighAvailable === true,
        proAvailable: config.proAvailable,
      },
      // This endpoint is deliberately one-shot. The launcher's normal Codex path may retain a
      // completed conversation for follow-up turns, but raw workflow calls must release their
      // Electron BrowserView as soon as the model response is complete.
      retainConversation: false,
      preserveFailedTab: false,
      preferClipboardPaste: true,
      // Raw workflow prompts can be much larger than normal helper-control frames. Prepare before
      // helper startup so LauncherBrowserHelperClient can move large payloads into its private,
      // digest-checked temporary-file handoff instead of sending them over helper stdin.
      prepareBeforeHelper: true,
      allowCompletionWithoutAction: true,
      abortSignal: req.signal,
      prepare: async () => ({ text: body.input as string, images: [], release: () => {} }),
      onTextDelta: () => {},
      });
    } finally {
      await worker.close?.().catch(error => {
        console.warn(
          `[browser-responses] helper cleanup failed trace=${traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    console.info(
      `[browser-responses] completed trace=${traceId} answerChars=${answer.length} durationMs=${Date.now() - startedAt}`,
    );

    return Response.json({
      id: traceId,
      object: "browser.response",
      status: "completed",
      model: route.slug,
      output_text: answer,
    });
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) return adapterErrorResponse(error);
    if (error instanceof DOMException && error.name === "AbortError") {
      return formatErrorResponse(499, "client_closed_request", "Browser response request was cancelled");
    }
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
