import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	CodexPetActivity,
	CodexPetAnimationState,
	CodexPetSpawnResponse,
	CodexPetSummary,
	CodexPetsResponse,
} from "../../../../shared/index";
import type {
	CodexPetCatalogEntry,
	CodexPetsListResponse,
} from "../../../../shared/rpc/pets";
import {
	codexHome,
	listCodexPets,
	PET_ANIMATION_ROWS,
	type PetSummary,
} from "../../../plugins/codex-pets";
import type { RpcDeps } from "../types";

/**
 * Codex pet RPC handlers. Ported from origin/main's pet block
 * (75548e45 + 8d8d8fe8 + ab2d2f36 + f6f709d9). Origin scattered pet
 * state management across the ApiServer class; here it lives as
 * module-level state since (a) there's at most one pet active per
 * process and (b) RPC handlers are pure-function-over-deps so we'd
 * need a service object anyway. Kept minimal — when the agent-task
 * service lands, petActivity can be enriched with
 * runningAgents instead of returning an empty list.
 */

const PET_ATLAS = {
	columns: 8,
	rows: 9,
	cellWidth: 192,
	cellHeight: 208,
	width: 1536,
	height: 1872,
} as const;

const STATE_OVERRIDE_TTL_MS = 9_000;

type PetStateOverride = { state: CodexPetAnimationState; expiresAt: number };

let activePetId: string | null = null;
let activePetStateOverride: PetStateOverride | null = null;

function toCodexPetSummary(pet: PetSummary): CodexPetSummary {
	// Bundled pets live at `views/main/pets/<id>/spritesheet.webp` inside
	// the .app — the pet window (loaded at `views://main/pet.html`) can
	// reach them via `views://main/pets/<id>/spritesheet.webp` from the
	// SAME origin. WKWebView blocks both file:// loads from a views://
	// origin AND cross-path resource loads inside the views:// tree, so
	// the spritesheet has to share the views/main/ prefix with the page.
	//
	// For non-bundled pets we still emit file:// (works only if the
	// webview has explicit navigation-rule allowance). To make every
	// user pet "just work," drop ~/.codex/pets/<id>/ into
	// build-assets/pets/<id>/ and rebuild the app.
	const dirName = basename(pet.directory);
	const spritesheetUrl = pet.bundled
		? `views://main/pets/${dirName}/spritesheet.webp`
		: `file://${pet.spritesheetPath}`;
	return {
		...pet,
		spritesheetUrl,
		atlas: PET_ATLAS,
	};
}

function petsResponse(): CodexPetsResponse {
	const result = listCodexPets();
	return {
		pets: result.pets.map(toCodexPetSummary),
		errors: result.errors,
	};
}

function findPet(query?: string | null): CodexPetSummary | null {
	const response = petsResponse();
	if (response.pets.length === 0) return null;
	const normalized = query?.trim().toLowerCase();
	if (!normalized) {
		const active = activePetId
			? response.pets.find((pet) => pet.id === activePetId)
			: null;
		return active ?? response.pets[0] ?? null;
	}
	return (
		response.pets.find(
			(pet) =>
				pet.id.toLowerCase() === normalized ||
				pet.displayName.toLowerCase() === normalized,
		) ?? null
	);
}

function currentPetState(): CodexPetAnimationState {
	const override = activePetStateOverride;
	if (!override) return "idle";
	if (override.expiresAt > Date.now()) return override.state;
	activePetStateOverride = null;
	return "idle";
}

function toCatalogEntry(pet: PetSummary): CodexPetCatalogEntry {
	const summary = toCodexPetSummary(pet);
	return {
		...summary,
		bundled: pet.bundled === true,
		animations: PET_ANIMATION_ROWS.map((r) => ({
			state: r.state as CodexPetAnimationState,
			row: r.row,
			frames: r.frames,
			purpose: r.purpose,
		})),
	};
}

/**
 * Sync custom pets from ~/.codex/pets/ into build-assets/pets/ so they
 * get bundled into the app on the next electrobun rebuild. Only copies
 * pets whose id doesn't already exist in build-assets — existing
 * bundled entries with richer metadata (companionPreset, persona, etc.)
 * are never overwritten.
 */
function syncCustomPetsToBuildAssets(): { synced: string[]; errors: string[] } {
	const synced: string[] = [];
	const errors: string[] = [];
	const userPetsRoot = join(codexHome(), "pets");
	if (!existsSync(userPetsRoot)) return { synced, errors };
	const here = dirname(new URL(import.meta.url).pathname);
	const buildAssetsRoot = join(here, "..", "..", "..", "..", "build-assets", "pets");
	if (!existsSync(buildAssetsRoot)) return { synced, errors };
	for (const entry of readdirSync(userPetsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const srcDir = join(userPetsRoot, entry.name);
		const destDir = join(buildAssetsRoot, entry.name);
		if (existsSync(destDir)) continue; // bundled version wins
		if (!existsSync(join(srcDir, "pet.json"))) continue;
		try {
			mkdirSync(destDir, { recursive: true });
			for (const file of readdirSync(srcDir)) {
				if (file.startsWith(".")) continue;
				copyFileSync(join(srcDir, file), join(destDir, file));
			}
			synced.push(entry.name);
		} catch (err) {
			errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { synced, errors };
}

export function petsRequests(deps: RpcDeps) {
	return {
		petActive: async (
			_params: Record<string, never>,
		): Promise<{ pet: CodexPetSummary | null; state: CodexPetAnimationState }> => {
			const pet = findPet();
			return { pet, state: currentPetState() };
		},
		petsList: async (
			_params: Record<string, never>,
		): Promise<CodexPetsListResponse> => {
			const result = listCodexPets();
			return {
				pets: result.pets.map(toCatalogEntry),
				errors: result.errors,
			};
		},
		petSpawn: async (params: { pet?: string }): Promise<CodexPetSpawnResponse> => {
			// Sync any new custom pets from ~/.codex/pets/ into build-assets/
			// before resolving — ensures new user pets get bundled.
			syncCustomPetsToBuildAssets();
			const pet = findPet(typeof params.pet === "string" ? params.pet : null);
			if (!pet) throw new Error("Codex pet not found");
			if (!existsSync(pet.spritesheetPath)) throw new Error("pet spritesheet missing");
			activePetId = pet.id;
			deps.broadcaster.broadcast("uiOpenPet", {});
			return { pet, state: currentPetState() };
		},
		petActivity: async (_params: Record<string, never>): Promise<CodexPetActivity> => {
			const runtime = deps.activity.runtimeSnapshot();
			const recentLogs = deps.activity.logs.list({ limit: 6 });
			return {
				state: currentPetState(),
				summary: runtime.available ? "Codex agent ready" : "Codex agent offline",
				...(runtime.agentName ? { detail: `Agent: ${runtime.agentName}` } : {}),
				// Agent-task service is not yet in flatten; when it lands,
				// populate runningAgents from active task sessions.
				runningAgents: [],
				recentLogs,
				runtime: {
					available: runtime.available,
					agentName: runtime.agentName,
					counts: runtime.counts,
				},
				updatedAt: Date.now(),
			};
		},
	};
}

/**
 * petWindowDrag handler — registered by the bun-side pet feature
 * (src/bun/features/pet/index.ts) so it can translate drag deltas
 * into BrowserWindow.setPosition. Lives at module scope rather than
 * on RpcDeps because the feature is the only thing that knows about
 * the pet window handle, and there's at most one active pet window.
 */
let dragHandler: ((delta: { dx: number; dy: number }) => void) | null = null;

export function setPetWindowDragHandler(
	fn: ((delta: { dx: number; dy: number }) => void) | null,
): void {
	dragHandler = fn;
}

export function petsMessages(_deps: RpcDeps) {
	return {
		petWindowDrag: (payload: { dx: number; dy: number }) => {
			dragHandler?.(payload);
		},
	};
}
