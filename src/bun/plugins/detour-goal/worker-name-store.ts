/**
 * Persistent worker-name registry.
 *
 * PTYService's in-memory `sessionNames` map is fine while the runtime
 * is alive, but it can't answer "what did Hungover Owl do yesterday?"
 * after a restart. We persist generated names to a JSON file so the
 * agent (and the user) can keep referring to past workers by name.
 *
 * File: `${ELIZA_STATE_DIR or ~/.detour}/worker-names.json`
 * Shape: `{ <messageOrSessionId>: { name: "Hungover Owl",
 *           generatedAt: 1778900000, action: "CREATE_TASK" } }`
 *
 * The store is intentionally append-only (with a sliding cap) — names
 * are never updated, just added. If the file is missing or corrupt we
 * fall back to an empty store so the runtime keeps booting.
 *
 * Cap: 10,000 entries. Hard delete oldest on overflow. At one entry
 * per spawn that's roughly a year of activity for a busy agent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type WorkerNameRecord = {
	name: string;
	generatedAt: number;
	action?: string;
};

export type WorkerNameStoreState = {
	version: 1;
	entries: Record<string, WorkerNameRecord>;
};

const MAX_ENTRIES = 10_000;

function defaultStorePath(): string {
	const dir =
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), ".detour");
	return join(dir, "worker-names.json");
}

function emptyState(): WorkerNameStoreState {
	return { version: 1, entries: {} };
}

function trimToMax(state: WorkerNameStoreState): WorkerNameStoreState {
	const keys = Object.keys(state.entries);
	if (keys.length <= MAX_ENTRIES) return state;
	const sorted = keys
		.map((k) => ({ k, t: state.entries[k]!.generatedAt }))
		.sort((a, b) => b.t - a.t)
		.slice(0, MAX_ENTRIES);
	const next: Record<string, WorkerNameRecord> = {};
	for (const { k } of sorted) next[k] = state.entries[k]!;
	return { version: 1, entries: next };
}

export function readStore(path = defaultStorePath()): WorkerNameStoreState {
	if (!existsSync(path)) return emptyState();
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<WorkerNameStoreState>;
		if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
			return { version: 1, entries: { ...parsed.entries } };
		}
		return emptyState();
	} catch {
		return emptyState();
	}
}

export function writeStore(state: WorkerNameStoreState, path = defaultStorePath()): void {
	try {
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const trimmed = trimToMax(state);
		writeFileSync(path, JSON.stringify(trimmed, null, 2), { encoding: "utf8", mode: 0o600 });
	} catch {
		// Persistence is best-effort. The in-memory map still works for
		// the current session.
	}
}

export function recordWorkerName(
	key: string,
	record: WorkerNameRecord,
	path = defaultStorePath(),
): void {
	const state = readStore(path);
	state.entries[key] = record;
	writeStore(state, path);
}

export function lookupWorkerName(
	key: string,
	path = defaultStorePath(),
): WorkerNameRecord | null {
	const state = readStore(path);
	return state.entries[key] ?? null;
}

export function allWorkerNames(path = defaultStorePath()): WorkerNameStoreState["entries"] {
	return readStore(path).entries;
}
