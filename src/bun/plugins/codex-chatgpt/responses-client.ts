/**
 * ChatGPT-subscription Responses API client.
 *
 * Endpoint:   POST https://chatgpt.com/backend-api/codex/responses
 * Wire fmt:   OpenAI Responses API (NOT Chat Completions)
 * Auth:       Bearer <oauth_access_token>  +  ChatGPT-Account-Id header
 *
 * Mirrors what Codex CLI does (see openai/codex repo, codex-rs/core/src/client.rs
 * and codex-rs/model-provider/src/bearer_auth_provider.rs). We talk Responses
 * API natively rather than translating Chat Completions because the format
 * differs substantially and translation would be fragile.
 */

import { decodeCodexJwt } from "./jwt";
import { parseQuotaError } from "./quota-error";

export { QuotaExceededError, type QuotaExceededDetails } from "./quota-error";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_RESPONSES_PATH = "/codex/responses";
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const OPENAI_BETA_HEADER = "responses=experimental";

export type ResponsesContentItem =
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
	| { type: "output_text"; text: string };

export type ResponsesInputItem =
	| { type: "message"; role: "user" | "assistant" | "system" | "developer"; content: string | ResponsesContentItem[] }
	| { type: "function_call_output"; call_id: string; output: string }
	| { type: "image_generation_call"; id: string; result?: string };

export interface ResponsesToolImageGeneration {
	type: "image_generation";
	quality?: "low" | "medium" | "high" | "auto";
	size?: string;
	background?: "transparent" | "opaque" | "auto";
}

export interface ResponsesToolFunction {
	type: "function";
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
	strict?: boolean;
}

export type ResponsesTool = ResponsesToolImageGeneration | ResponsesToolFunction;

export interface CreateResponseRequest {
	model: string;
	input: string | ResponsesInputItem[];
	instructions?: string;
	tools?: ResponsesTool[];
	tool_choice?: "auto" | "required" | "none" | { type: "function"; name: string };
	stream?: boolean;
	previous_response_id?: string;
	reasoning?: { effort?: "minimal" | "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" };
	max_output_tokens?: number;
	store?: boolean;
}

/** A small subset of the streaming events we care about for chat + image gen. */
export type ResponsesStreamEvent =
	| { type: "response.created"; response: { id: string; status: string } }
	| { type: "response.in_progress" }
	| { type: "response.output_text.delta"; delta: string; item_id?: string; output_index?: number }
	| { type: "response.output_text.done"; text: string }
	| { type: "response.output_item.added"; item: Record<string, unknown> }
	| { type: "response.output_item.done"; item: Record<string, unknown> }
	| {
			type: "response.image_generation_call.partial_image";
			partial_image_b64: string;
			partial_image_index: number;
			item_id?: string;
	  }
	| { type: "response.image_generation_call.in_progress"; item_id?: string }
	| { type: "response.image_generation_call.completed"; item_id?: string }
	| { type: "response.completed"; response: Record<string, unknown> }
	| { type: "response.failed"; response?: { error?: { message?: string } } }
	| { type: "response.error"; error?: { message?: string } }
	| { type: string; [k: string]: unknown };

export interface CodexResponsesClientOptions {
	readonly accessToken: string;
	readonly chatgptAccountId?: string;
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
}

export class CodexResponsesClient {
	private readonly accessToken: string;
	private readonly chatgptAccountId: string;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;

	constructor(opts: CodexResponsesClientOptions) {
		this.accessToken = opts.accessToken;
		const acctFromArg = opts.chatgptAccountId?.trim() || "";
		const acctFromJwt = !acctFromArg ? decodeCodexJwt(opts.accessToken)?.chatgptAccountId ?? "" : "";
		this.chatgptAccountId = acctFromArg || acctFromJwt;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.baseUrl = opts.baseUrl ?? CODEX_BASE_URL;
		if (!this.chatgptAccountId) {
			throw new Error(
				"CodexResponsesClient: chatgpt_account_id missing — pass it explicitly or use a token whose JWT carries the `https://api.openai.com/auth.chatgpt_account_id` claim.",
			);
		}
	}

	private headers(stream: boolean): HeadersInit {
		return {
			Authorization: `Bearer ${this.accessToken}`,
			"ChatGPT-Account-Id": this.chatgptAccountId,
			"OpenAI-Beta": OPENAI_BETA_HEADER,
			originator: CODEX_ORIGINATOR,
			"Content-Type": "application/json",
			Accept: stream ? "text/event-stream" : "application/json",
		};
	}

	/** Non-streaming response. Returns the full response object. */
	async create(req: CreateResponseRequest): Promise<Record<string, unknown>> {
		const res = await this.fetchImpl(`${this.baseUrl}${CODEX_RESPONSES_PATH}`, {
			method: "POST",
			headers: this.headers(false),
			body: JSON.stringify({ ...req, stream: false }),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			if (res.status === 429) {
				const quota = parseQuotaError(body);
				if (quota) throw quota;
			}
			throw new Error(`Codex Responses API ${res.status}: ${body.slice(0, 600)}`);
		}
		return res.json() as Promise<Record<string, unknown>>;
	}

	/**
	 * Streaming response. Async iterator over parsed SSE events.
	 *
	 * Usage:
	 *   for await (const ev of client.stream(req)) {
	 *     if (ev.type === "response.output_text.delta") onText(ev.delta);
	 *   }
	 */
	async *stream(req: CreateResponseRequest): AsyncGenerator<ResponsesStreamEvent, void, unknown> {
		const res = await this.fetchImpl(`${this.baseUrl}${CODEX_RESPONSES_PATH}`, {
			method: "POST",
			headers: this.headers(true),
			body: JSON.stringify({ ...req, stream: true }),
		});
		if (!res.ok || !res.body) {
			const body = await res.text().catch(() => "");
			if (res.status === 429) {
				const quota = parseQuotaError(body);
				if (quota) throw quota;
			}
			throw new Error(`Codex Responses API ${res.status}: ${body.slice(0, 600)}`);
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buf = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, nl);
					buf = buf.slice(nl + 2);
					const ev = parseSseFrame(frame);
					if (ev) yield ev;
				}
			}
			// Flush any trailing single-frame.
			if (buf.trim().length > 0) {
				const ev = parseSseFrame(buf);
				if (ev) yield ev;
			}
		} finally {
			reader.releaseLock();
		}
	}
}

function parseSseFrame(frame: string): ResponsesStreamEvent | null {
	let data = "";
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith("data:")) {
			data += line.slice(5).trimStart();
		}
	}
	if (!data || data === "[DONE]") return null;
	try {
		return JSON.parse(data) as ResponsesStreamEvent;
	} catch {
		return null;
	}
}
