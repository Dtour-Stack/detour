/**
 * Append-only audit log for every Pensieve mutation.
 *
 * Mirrors the plugin-vault-tools/src/audit.ts pattern. Logged to
 * ~/.eliza/audit/pensieve.jsonl. Best-effort — failures never block the
 * mutation; observability only.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PATH = join(homedir(), ".eliza", "audit", "pensieve.jsonl");

export type PensieveAuditAction =
	| "memory.update"
	| "memory.delete"
	| "relationship.create"
	| "relationship.update"
	| "relationship.delete"
	| "relationship.merge"
	| "entity.update"
	| "task.run"
	| "task.pause"
	| "task.resume"
	| "task.delete";

export interface PensieveAuditEvent {
	readonly action: PensieveAuditAction;
	readonly target?: string;
	readonly success: boolean;
	readonly error?: string;
	readonly caller: string;
	readonly ts: number;
}

export function pensieveAudit(event: PensieveAuditEvent): void {
	try {
		mkdirSync(dirname(PATH), { recursive: true });
		appendFileSync(PATH, `${JSON.stringify(event)}\n`);
	} catch {
		// best effort
	}
}
