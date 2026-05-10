/**
 * Codex pet RPC. Replaces the legacy REST surface origin/main built on
 * top of WebClient (`/api/pets`, `/api/pets/active`, `/api/pets/spawn`,
 * `/api/pets/activity`, `PUT /api/pets/state`) — those routes are
 * gone in flatten; this group is the canonical entry point.
 *
 * Pet state broadcasts and drag events are messages, not requests:
 *   - petState (bun→view) — animation state changed (e.g. /codex turn
 *     started → "running"; turn failed → "failed").
 *   - petWindowDrag (view→bun) — pet window's pointermove during a
 *     drag; bun nudges the window position.
 */

import type {
	CodexPetActivity,
	CodexPetAnimationState,
	CodexPetSpawnResponse,
	CodexPetsResponse,
} from "../index";

export type PetsRequests = {
	petList: {
		params: Record<string, never>;
		response: CodexPetsResponse;
	};
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
	petSetState: {
		params: { state: CodexPetAnimationState; reason?: string };
		response: { state: CodexPetAnimationState };
	};
};

export type PetsMessages = {
	// Bun → pet view: the active pet's animation state changed. The
	// pet view drives the spritesheet animation off this. `reason` is
	// surfaced as a tooltip / banner so users see why the state
	// switched (e.g. "/codex started for ~/repos/x").
	petState: { state: CodexPetAnimationState; reason?: string };
	// View → bun: the pet window is being dragged. dx/dy are the
	// pointermove delta since the last event; bun translates them to
	// `BrowserWindow.setPosition` so the system-level window follows
	// the cursor without leaving the in-window drag region.
	petWindowDrag: { dx: number; dy: number };
};
