/**
 * Best-effort agent-action audit log so the user can see what the agent
 * did against the vault. Append-only JSONL at ~/.eliza/audit/agent-vault-actions.jsonl.
 * Failures here never block the action — auditing is observability, not a gate.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PATH = join(homedir(), ".eliza", "audit", "agent-vault-actions.jsonl");

export type AuditAction =
	| "vault_read"
	| "vault_write"
	| "vault_delete"
	| "vault_list"
	| "login_list"
	| "login_reveal"
	| "login_save";

export interface AuditEvent {
	readonly action: AuditAction;
	readonly key?: string;
	readonly domain?: string;
	readonly username?: string;
	readonly source?: string;
	readonly success: boolean;
	readonly error?: string;
	readonly caller: string;
	readonly ts: number;
}

export function audit(event: AuditEvent): void {
	try {
		mkdirSync(dirname(PATH), { recursive: true });
		appendFileSync(PATH, `${JSON.stringify(event)}\n`);
	} catch {
		// best-effort
	}
}
