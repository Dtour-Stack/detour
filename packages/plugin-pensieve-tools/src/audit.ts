/**
 * Best-effort audit log for agent-side Pensieve mutations. Mirrors
 * @detour/plugin-vault-tools/audit.ts so the user can see what the agent did.
 *
 * Append-only JSONL at ~/.eliza/audit/agent-pensieve-actions.jsonl. Failures
 * never block the action — auditing is observability, not a gate.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PATH = join(homedir(), ".eliza", "audit", "agent-pensieve-actions.jsonl");

export type AuditAction =
	| "pensieve_write"
	| "pensieve_read"
	| "pensieve_list"
	| "pensieve_search"
	| "pensieve_link"
	| "pensieve_template_upsert"
	| "pensieve_template_render"
	| "pensieve_var_set";

export interface AuditEvent {
	readonly action: AuditAction;
	readonly target?: string;
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
		// best effort
	}
}
