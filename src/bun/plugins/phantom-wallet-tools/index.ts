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
import { gmgnRequest, loadGmgnConfig } from "../../core/gmgn-client";

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

const phantomSignMessageHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["message", "text"]);
	const messageBase64Param = pickString(opts, ["messageBase64", "message_base64"]);
	let messageBase64: string;
	if (messageBase64Param) {
		messageBase64 = messageBase64Param;
	} else if (text) {
		messageBase64 = Buffer.from(text, "utf8").toString("base64");
	} else {
		const m = "Missing message (params: message text OR messageBase64)";
		await emit(callback, m, "PHANTOM_SOLANA_SIGN_MESSAGE");
		return fail(m);
	}
	try {
		const out = await invokeFirstViewRequest("phantomViewSolanaSignMessage", { messageBase64 });
		const result = JSON.stringify(out, null, 2);
		await emit(callback, result, "PHANTOM_SOLANA_SIGN_MESSAGE");
		return ok(result);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await emit(callback, msg, "PHANTOM_SOLANA_SIGN_MESSAGE");
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

const phantomWalletReportHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const chainParam = (pickString(opts, ["chain"]) ?? "sol").toLowerCase();
	const chain = chainParam === "eth" || chainParam === "base" || chainParam === "bsc" ? chainParam : "sol";
	const period = pickString(opts, ["period"]) === "30d" ? "30d" : "7d";
	const overrideWallet = pickString(opts, ["wallet", "walletAddress", "address"]);

	let wallet = overrideWallet ?? "";
	if (!wallet) {
		try {
			const status = (await invokeFirstViewRequest("phantomViewGetWalletStatus", {})) as {
				connected: boolean;
				solanaAddress: string | null;
				ethereumAddress: string | null;
			};
			if (!status.connected) {
				const m = "Phantom is not connected — open Detour → Settings → Phantom wallet and click Connect, or pass an explicit wallet param.";
				await emit(callback, m, "PHANTOM_WALLET_REPORT");
				return fail(m);
			}
			wallet = (chain === "sol" ? status.solanaAddress : status.ethereumAddress) ?? "";
			if (!wallet) {
				const m = `Phantom has no ${chain === "sol" ? "Solana" : "EVM"} address connected. Reconnect via Settings → Phantom wallet with that address type.`;
				await emit(callback, m, "PHANTOM_WALLET_REPORT");
				return fail(m);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await emit(callback, msg, "PHANTOM_WALLET_REPORT");
			return fail(msg);
		}
	}

	const cfg = loadGmgnConfig();
	if (!cfg.configured) {
		const m = `Wallet detected (${wallet}, chain=${chain}) but GMGN analytics are disabled: ${cfg.reason}`;
		await emit(callback, m, "PHANTOM_WALLET_REPORT");
		return ok(m);
	}

	try {
		const [holdings, stats, activity] = await Promise.all([
			gmgnRequest({
				method: "GET",
				subPath: "/v1/user/wallet_holdings",
				query: { chain, wallet_address: wallet, limit: 20, order_by: "usd_value", direction: "desc" },
			}).catch((e) => ({ __error: e instanceof Error ? e.message : String(e) })),
			gmgnRequest({
				method: "GET",
				subPath: "/v1/user/wallet_stats",
				query: { chain, wallet_address: [wallet], period },
			}).catch((e) => ({ __error: e instanceof Error ? e.message : String(e) })),
			gmgnRequest({
				method: "GET",
				subPath: "/v1/user/wallet_activity",
				query: { chain, wallet_address: wallet, limit: 20 },
			}).catch((e) => ({ __error: e instanceof Error ? e.message : String(e) })),
		]);
		const text = JSON.stringify({ wallet, chain, period, holdings, stats, activity }, null, 2);
		await emit(callback, text, "PHANTOM_WALLET_REPORT");
		return ok(text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await emit(callback, msg, "PHANTOM_WALLET_REPORT");
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

const phantomWalletReport: Action = {
	name: "PHANTOM_WALLET_REPORT",
	similes: ["MY_WALLET_STATS", "WALLET_REPORT", "MY_PORTFOLIO"],
	description:
		"Pull the user's wallet portfolio + PnL + recent activity for their connected Phantom wallet via GMGN. Auto-resolves the Solana (or EVM) address from the open Phantom session. Returns raw GMGN holdings + stats + activity payloads for the agent to summarize. Params: chain? (sol|eth|base|bsc, default sol), period? (7d|30d, default 7d), wallet? (override). Requires GMGN_API_KEY.",
	validate: alwaysValid,
	handler: phantomWalletReportHandler,
};

const phantomSolanaSignMessage: Action = {
	name: "PHANTOM_SOLANA_SIGN_MESSAGE",
	similes: ["SIGN_MESSAGE_PHANTOM", "PHANTOM_SIGN_MESSAGE"],
	description:
		"Sign an arbitrary message with the user's Phantom Solana key (proof of wallet ownership). Params: message (utf-8 text) or messageBase64. Returns base64 signature + Solana public key.",
	validate: alwaysValid,
	handler: phantomSignMessageHandler,
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
	actions: [phantomGetStatus, phantomWalletReport, phantomSolanaSignAndSend, phantomSolanaSignMessage, phantomEvmSend],
};
