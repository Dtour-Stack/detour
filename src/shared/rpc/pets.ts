/**
 * Codex pet RPC. Replaces the legacy REST surface origin/main built on
 * top of WebClient (`/api/pets`, `/api/pets/active`, `/api/pets/spawn`,
 * `/api/pets/activity`) — those routes are gone in flatten; this group
 * is the canonical entry point.
 *
 * View → bun drag events are messages, not requests:
 *   - petWindowDrag (view→bun) — pet window's pointermove during a
 *     drag; bun nudges the window position.
 */

import type {
	CodexPetActivity,
	CodexPetAnimationState,
	CodexPetSpawnResponse,
} from "../index";

export type PetsRequests = {
	petActive: {
		params: Record<string, never>;
		// Null pet when no Codex pets are installed; mirrors origin's
		// 404 → null mapping but keeps the response type simple.
		response: { pet: CodexPetSpawnResponse["pet"] | null; state: CodexPetAnimationState };
	};
	petSpawn: {
		params: { pet?: string };
		response: CodexPetSpawnResponse;
	};
	petActivity: {
		params: Record<string, never>;
		response: CodexPetActivity;
	};
};

export type PetsMessages = {
	// View → bun: the pet window is being dragged. dx/dy are the
	// pointermove delta since the last event; bun translates them to
	// `BrowserWindow.setPosition` so the system-level window follows
	// the cursor without leaving the in-window drag region.
	petWindowDrag: { dx: number; dy: number };
};
