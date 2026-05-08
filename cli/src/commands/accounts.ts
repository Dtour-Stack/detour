import type { CliClient } from "../client";

const SUB_LABEL: Record<string, string> = {
	"anthropic-subscription": "Claude (Pro/Max OAuth)",
	"openai-codex": "ChatGPT / Codex",
};

const DIRECT_LABEL: Record<string, string> = {
	"anthropic-api": "Anthropic API",
	"openai-api": "OpenAI API",
	"deepseek-api": "DeepSeek API",
	"zai-api": "Z.ai API",
	"moonshot-api": "Moonshot API",
};

function fmtExpires(expires?: number) {
	if (!expires) return "";
	const ms = expires - Date.now();
	if (ms < 0) return " (expired)";
	const days = Math.floor(ms / 86_400_000);
	if (days >= 1) return ` (in ${days}d)`;
	const hours = Math.floor(ms / 3_600_000);
	return ` (in ${hours}h)`;
}

export async function listAccounts(client: CliClient): Promise<void> {
	const accts = await client.listAllAccounts();
	const providers = await client.getAuthProviders();

	console.log("\nSubscription auth (OAuth):");
	for (const p of providers.subscription) {
		const list = accts[p] ?? [];
		console.log(`\n  ${SUB_LABEL[p] ?? p}`);
		if (list.length === 0) {
			console.log("    (no accounts — `detour accounts connect " + p + "`)");
		} else {
			for (const a of list) {
				const exp = fmtExpires(a.expires);
				const tag = a.expired ? "[EXPIRED]" : "[ok]";
				console.log(`    ${tag.padEnd(11)} ${a.label.padEnd(12)} ${a.tokenPreview ?? "—"}${exp}`);
			}
		}
	}

	console.log("\n\nDirect API keys:");
	for (const p of providers.direct) {
		const list = accts[p] ?? [];
		console.log(`\n  ${DIRECT_LABEL[p] ?? p} (${list.length})`);
		for (const a of list) {
			console.log(`    ${a.label.padEnd(12)} ${a.tokenPreview ?? "—"}`);
		}
	}
	console.log();
}

export async function connectAccount(
	client: CliClient,
	provider: string,
	label = "Default",
): Promise<void> {
	const handle = await client.startAuthFlow(provider, label);
	console.log(`\n→ Open this URL in your browser to authenticate:\n\n  ${handle.authUrl}\n`);

	if (handle.needsCodeSubmission) {
		console.log("After authorizing, paste the `code#state` string from the redirect page:");
		process.stdout.write("code> ");
		for await (const line of console) {
			const code = line.trim();
			if (!code) continue;
			const r = await client.submitFlowCode(handle.sessionId, code);
			if (!r.ok) {
				console.error("Submit failed; try again.");
				process.stdout.write("code> ");
				continue;
			}
			break;
		}
	}

	// Poll for terminal state
	while (true) {
		await new Promise((r) => setTimeout(r, 1500));
		const state = await client.getAuthFlow(handle.sessionId).catch(() => null);
		if (!state) {
			console.error("Flow disappeared.");
			process.exit(1);
		}
		if (state.status === "success") {
			console.log(`✓ connected: ${state.account?.label} (${state.providerId})`);
			return;
		}
		if (state.status === "error" || state.status === "timeout" || state.status === "cancelled") {
			console.error(`✗ ${state.status}: ${state.error ?? "(no detail)"}`);
			process.exit(1);
		}
	}
}

export async function removeAccount(
	client: CliClient,
	provider: string,
	accountId: string,
): Promise<void> {
	await client.deleteAccount(provider, accountId);
	console.log(`removed: ${provider}/${accountId}`);
}
