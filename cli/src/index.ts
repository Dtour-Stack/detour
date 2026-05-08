import type { ProviderId } from "@detour/shared";
import { CliClient, NoServerError, discoverServer } from "./client";
import { runChat } from "./commands/chat";
import {
	listProviders,
	removeProviderKey,
	setActiveProvider,
	setProviderKey,
} from "./commands/providers";
import { showStatus } from "./commands/status";
import { connectAccount, listAccounts, removeAccount } from "./commands/accounts";
import {
	getKey,
	listBackends,
	listInventory,
	listLogins,
	removeKey,
	revealLogin,
	setKey,
} from "./commands/vault";

const HELP = `\
detour — agent CLI

Chat:
  detour                                start interactive chat (default)
  detour chat                           start interactive chat

Status:
  detour status                         show running-agent info
  detour --help                         show this help

LLM providers:
  detour providers                      list providers
  detour providers add <id> <key>       store an API key
  detour providers active <id>          switch active provider
  detour providers remove <id>          delete a stored key

Vault (any key):
  detour vault list                     list all vault entries
  detour vault get <key>                print value (sensitive)
  detour vault set <key> <value>        store a sensitive value
  detour vault set --plain <key> <val>  store a non-sensitive value
  detour vault rm <key>                 delete an entry

Saved logins:
  detour logins                         list saved logins (in-house + 1P + BW)
  detour logins reveal <source> <id>    print full credential

Backends:
  detour backends                       list password-manager backends

Accounts (subscription auth + direct API):
  detour accounts                       list all accounts (Claude, Codex, etc.)
  detour accounts connect <provider>    OAuth flow to add a new account
  detour accounts remove <provider> <id> delete an account

  Subscription providers: anthropic-subscription, openai-codex
  Direct providers: anthropic-api, openai-api, deepseek-api, zai-api, moonshot-api

Provider ids: anthropic, openai, openrouter
Requires the detour tray app to be running.`;

async function main(argv: string[]): Promise<void> {
	const [cmd, ...rest] = argv;

	if (cmd === "--help" || cmd === "-h" || cmd === "help") {
		console.log(HELP);
		return;
	}

	let lock;
	try {
		lock = discoverServer();
	} catch (err) {
		if (err instanceof NoServerError) {
			console.error(err.message);
			process.exit(1);
		}
		throw err;
	}

	const client = new CliClient(lock.port);
	await client.connect();

	try {
		const command = cmd ?? "chat";
		switch (command) {
			case "chat":
				await runChat(client);
				break;
			case "status":
				await showStatus(client, lock);
				break;
			case "providers":
				await handleProviders(client, rest);
				break;
			case "vault":
				await handleVault(client, rest);
				break;
			case "logins":
				await handleLogins(client, rest);
				break;
			case "backends":
				await listBackends(client);
				break;
			case "accounts":
				await handleAccounts(client, rest);
				break;
			default:
				console.error(`Unknown command: ${command}\n`);
				console.log(HELP);
				process.exit(2);
		}
	} finally {
		client.close();
	}
}

async function handleProviders(client: CliClient, args: string[]): Promise<void> {
	const [sub, id, key] = args;
	if (!sub) return listProviders(client);
	if (sub === "add" && id && key) return setProviderKey(client, id as ProviderId, key);
	if (sub === "active" && id) return setActiveProvider(client, id as ProviderId);
	if (sub === "remove" && id) return removeProviderKey(client, id as ProviderId);
	return failUsage("Usage: detour providers [add <id> <key> | active <id> | remove <id>]");
}

async function handleVault(client: CliClient, args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	if (!sub || sub === "list") return listInventory(client);
	if (sub === "get" && rest[0]) return getKey(client, rest[0]);
	if (sub === "set") return setVaultEntry(client, rest);
	if ((sub === "rm" || sub === "remove" || sub === "delete") && rest[0]) return removeKey(client, rest[0]);
	return failUsage("Usage: detour vault [list | get <key> | set [--plain] <key> <value> | rm <key>]");
}

async function setVaultEntry(client: CliClient, args: string[]): Promise<void> {
	const plain = args[0] === "--plain";
	const offset = plain ? 1 : 0;
	const key = args[offset];
	const value = args[offset + 1];
	if (!key || value === undefined) return failUsage("Usage: detour vault set [--plain] <key> <value>");
	return setKey(client, key, value, !plain);
}

async function handleLogins(client: CliClient, args: string[]): Promise<void> {
	const [sub, source, id] = args;
	if (!sub) return listLogins(client);
	if (sub === "reveal" && source && id) return revealLogin(client, source, id);
	return failUsage("Usage: detour logins [reveal <source> <identifier>]");
}

async function handleAccounts(client: CliClient, args: string[]): Promise<void> {
	const [sub, provider, accountId] = args;
	if (!sub || sub === "list") return listAccounts(client);
	if (sub === "connect" && provider) return connectAccount(client, provider, accountId ?? "Default");
	if ((sub === "remove" || sub === "rm" || sub === "delete") && provider && accountId) {
		return removeAccount(client, provider, accountId);
	}
	return failUsage("Usage: detour accounts [list | connect <provider> [label] | remove <provider> <id>]");
}

function failUsage(message: string): never {
	console.error(message);
	process.exit(2);
}

await main(process.argv.slice(2));
