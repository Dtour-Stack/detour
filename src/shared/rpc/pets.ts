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
	CodexPetSummary,
} from "../index";

/**
 * Sprite-atlas row coverage so the gallery can render every animation
 * the pet's spritesheet supports (idle / waving / jumping / running /
 * etc.). Each entry maps a named animation state to its row in the
 * atlas + frame count + a stable purpose label so the UI can render
 * a labelled animated preview per row.
 */
export type CodexPetAnimationRow = {
	state: CodexPetAnimationState;
	row: number;
	frames: number;
	purpose: string;
};

export type CodexPetCatalogEntry = CodexPetSummary & {
	bundled: boolean;
	animations: CodexPetAnimationRow[];
};

export type CodexPetsListResponse = {
	pets: CodexPetCatalogEntry[];
	errors: string[];
};

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
	/**
	 * Full catalog of installed pets — both bundled (shipped with the
	 * .app) and user-supplied (~/.codex/pets/). Used by the gallery's
	 * "Pets" tab so the user can browse / inspect every pet on disk,
	 * not just the currently-spawned one.
	 */
	petsList: {
		params: Record<string, never>;
		response: CodexPetsListResponse;
	};
};

export type PetsMessages = {
	// View → bun: the pet window is being dragged. dx/dy are the
	// pointermove delta since the last event; bun translates them to
	// `BrowserWindow.setPosition` so the system-level window follows
	// the cursor without leaving the in-window drag region.
	petWindowDrag: { dx: number; dy: number };
};
