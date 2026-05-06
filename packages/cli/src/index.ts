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
			case "providers": {
				const [sub, id, key] = rest;
				if (!sub) {
					await listProviders(client);
				} else if (sub === "add" && id && key) {
					await setProviderKey(client, id as ProviderId, key);
				} else if (sub === "active" && id) {
					await setActiveProvider(client, id as ProviderId);
				} else if (sub === "remove" && id) {
					await removeProviderKey(client, id as ProviderId);
				} else {
					console.error("Usage: detour providers [add <id> <key> | active <id> | remove <id>]");
					process.exit(2);
				}
				break;
			}
			case "vault": {
				const [sub, ...args] = rest;
				if (!sub || sub === "list") {
					await listInventory(client);
				} else if (sub === "get" && args[0]) {
					await getKey(client, args[0]);
				} else if (sub === "set") {
					const plain = args[0] === "--plain";
					const offset = plain ? 1 : 0;
					const k = args[offset];
					const v = args[offset + 1];
					if (!k || v === undefined) {
						console.error("Usage: detour vault set [--plain] <key> <value>");
						process.exit(2);
					}
					await setKey(client, k, v, !plain);
				} else if ((sub === "rm" || sub === "remove" || sub === "delete") && args[0]) {
					await removeKey(client, args[0]);
				} else {
					console.error("Usage: detour vault [list | get <key> | set [--plain] <key> <value> | rm <key>]");
					process.exit(2);
				}
				break;
			}
			case "logins": {
				const [sub, source, id] = rest;
				if (!sub) {
					await listLogins(client);
				} else if (sub === "reveal" && source && id) {
					await revealLogin(client, source, id);
				} else {
					console.error("Usage: detour logins [reveal <source> <identifier>]");
					process.exit(2);
				}
				break;
			}
			case "backends":
				await listBackends(client);
				break;
			case "accounts": {
				const [sub, provider, accountId] = rest;
				if (!sub || sub === "list") {
					await listAccounts(client);
				} else if (sub === "connect" && provider) {
					await connectAccount(client, provider, accountId ?? "Default");
				} else if ((sub === "remove" || sub === "rm" || sub === "delete") && provider && accountId) {
					await removeAccount(client, provider, accountId);
				} else {
					console.error("Usage: detour accounts [list | connect <provider> [label] | remove <provider> <id>]");
					process.exit(2);
				}
				break;
			}
			default:
				console.error(`Unknown command: ${command}\n`);
				console.log(HELP);
				process.exit(2);
		}
	} finally {
		client.close();
	}
}

await main(process.argv.slice(2));
