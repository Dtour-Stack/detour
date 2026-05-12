/**
 * Agent-callable Phantom Connect bridge — Solana + EVM via the same
 * view RPC path as `phantom*` handlers (requires an open Detour window
 * and PHANTOM_CONNECT_APP_ID).
 */

import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	IAgentRuntime,
	Plugin,
} from "@elizaos/core";
import { invokeFirstViewRequest } from "../../core/rpc/view-invoker";

function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickString(opts: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "phantom-wallet-tools" } as never, actionName);
	} catch {
		/* ignore */
	}
}

function fail(reason: string): ActionResult {
	return { success: false, text: reason };
}

function ok(text: string): ActionResult {
	return { success: true, text };
}

const phantomGetStatusHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	try {
		const s = await invokeFirstViewRequest("phantomViewGetWalletStatus", {});
		const text = JSON.stringify(s, null, 2);
		await emit(callback, text, "PHANTOM_GET_STATUS");
		return ok(text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await emit(callback, msg, "PHANTOM_GET_STATUS");
		return fail(msg);
	}
};

const phantomSolanaHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const serialized = pickString(opts, ["serializedTransactionBase64", "transaction"]);
	if (!serialized) {
		const m = "Missing serializedTransactionBase64";
		await emit(callback, m, "PHANTOM_SOLANA_SIGN_AND_SEND");
		return fail(m);
	}
	try {
		const out = await invokeFirstViewRequest("phantomViewSolanaSignAndSend", {
			serializedTransactionBase64: serialized,
		});
		const text = JSON.stringify(out, null, 2);
		await emit(callback, text, "PHANTOM_SOLANA_SIGN_AND_SEND");
		return ok(text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await emit(callback, msg, "PHANTOM_SOLANA_SIGN_AND_SEND");
		return fail(msg);
	}
};

const phantomEvmHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const to = pickString(opts, ["to"]);
	if (!to || !to.startsWith("0x")) {
		const m = "Missing or invalid to (must be 0x-prefixed)";
		await emit(callback, m, "PHANTOM_EVM_SEND_TRANSACTION");
		return fail(m);
	}
	const value = pickString(opts, ["value"]);
	const data = pickString(opts, ["data"]) as `0x${string}` | undefined;
	const gas = pickString(opts, ["gas"]);
	const chainId = pickString(opts, ["chainId"]);
	try {
		const out = await invokeFirstViewRequest("phantomViewEvmSendTransaction", {
			to: to as `0x${string}`,
			...(value !== undefined ? { value } : {}),
			...(data !== undefined ? { data } : {}),
			...(gas !== undefined ? { gas } : {}),
			...(chainId !== undefined ? { chainId } : {}),
		});
		const text = JSON.stringify(out, null, 2);
		await emit(callback, text, "PHANTOM_EVM_SEND_TRANSACTION");
		return ok(text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await emit(callback, msg, "PHANTOM_EVM_SEND_TRANSACTION");
		return fail(msg);
	}
};

const alwaysValid: Action["validate"] = async () => true;

const phantomGetStatus: Action = {
	name: "PHANTOM_GET_STATUS",
	similes: ["PHANTOM_WALLET_STATUS", "WALLET_STATUS_PHANTOM"],
	description:
		"Report embedded Phantom wallet connection and Solana/EVM addresses visible to Detour. Requires the user to have connected via Phantom in a Detour window.",
	validate: alwaysValid,
	handler: phantomGetStatusHandler,
};

const phantomSolanaSignAndSend: Action = {
	name: "PHANTOM_SOLANA_SIGN_AND_SEND",
	similes: ["SIGN_SEND_SOLANA_PHANTOM"],
	description:
		"Sign and broadcast a Solana versioned transaction via the user's Phantom embedded session. Params: serializedTransactionBase64 (base64 of serialized VersionedTransaction).",
	validate: alwaysValid,
	handler: phantomSolanaHandler,
};

const phantomEvmSend: Action = {
	name: "PHANTOM_EVM_SEND_TRANSACTION",
	similes: ["PHANTOM_ETH_SEND", "EVM_SEND_PHANTOM"],
	description:
		"Send an EVM transaction via Phantom embedded wallet. Params: to (0x…), optional value (wei as decimal string), data (0x…), gas, chainId.",
	validate: alwaysValid,
	handler: phantomEvmHandler,
};

export const phantomWalletToolsPlugin: Plugin = {
	name: "@detour/plugin-phantom-wallet-tools",
	description: "Phantom Connect embedded wallet — status, Solana sign-and-send, EVM send",
	actions: [phantomGetStatus, phantomSolanaSignAndSend, phantomEvmSend],
};
