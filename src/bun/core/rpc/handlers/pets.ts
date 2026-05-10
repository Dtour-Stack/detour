import { existsSync } from "node:fs";
import type {
	CodexPetActivity,
	CodexPetAnimationState,
	CodexPetSpawnResponse,
	CodexPetSummary,
	CodexPetsResponse,
} from "../../../../shared/index";
import { listCodexPets, type PetSummary } from "../../../plugins/codex-pets";
import type { RpcDeps } from "../types";

/**
 * Codex pet RPC handlers. Ported from origin/main's pet block
 * (75548e45 + 8d8d8fe8 + ab2d2f36 + f6f709d9). Origin scattered pet
 * state management across the ApiServer class; here it lives as
 * module-level state since (a) there's at most one pet active per
 * process and (b) RPC handlers are pure-function-over-deps so we'd
 * need a service object anyway. Kept minimal — when the workspace
 * agents service lands, petActivity can be enriched with
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

const PET_STATES = new Set<CodexPetAnimationState>([
	"idle",
	"running-right",
	"running-left",
	"waving",
	"jumping",
	"failed",
	"waiting",
	"running",
	"review",
]);

const STATE_OVERRIDE_TTL_MS = 9_000;

type PetStateOverride = { state: CodexPetAnimationState; expiresAt: number };

let activePetId: string | null = null;
let activePetStateOverride: PetStateOverride | null = null;

function toCodexPetSummary(pet: PetSummary): CodexPetSummary {
	return {
		...pet,
		// file:// URL keeps webview rendering simple — no custom
		// protocol, no in-memory base64 round-trip. PetWindow loads
		// the spritesheet directly from disk; navigation rules in
		// the pet view permit file:// for the spritesheet path.
		spritesheetUrl: `file://${pet.spritesheetPath}`,
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

export function petsRequests(deps: RpcDeps) {
	return {
		petList: async (_params: Record<string, never>): Promise<CodexPetsResponse> => {
			return petsResponse();
		},
		petActive: async (
			_params: Record<string, never>,
		): Promise<{ pet: CodexPetSummary | null; state: CodexPetAnimationState }> => {
			const pet = findPet();
			return { pet, state: currentPetState() };
		},
		petSpawn: async (params: { pet?: string }): Promise<CodexPetSpawnResponse> => {
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
				// Workspace-agents service is not yet in flatten; when it
				// lands, populate from readWorkspaceAgents().filter(running).slice(0,3).
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
		petSetState: async (params: {
			state: CodexPetAnimationState;
			reason?: string;
		}): Promise<{ state: CodexPetAnimationState }> => {
			if (!PET_STATES.has(params.state)) {
				throw new Error("invalid pet animation state");
			}
			activePetStateOverride = {
				state: params.state,
				expiresAt: Date.now() + STATE_OVERRIDE_TTL_MS,
			};
			deps.broadcaster.broadcast("petState", {
				state: params.state,
				...(params.reason ? { reason: params.reason } : {}),
			});
			return { state: currentPetState() };
		},
	};
}

/**
 * View → bun pet messages. petWindowDrag is a no-op until the
 * PetWindow + bun-side pet feature land (origin's tray pet feature
 * owned the BrowserWindow handle and translated drag deltas to
 * setPosition; flatten will register the same callback when its
 * src/bun/features/pet/index.ts arrives).
 */
export function petsMessages(_deps: RpcDeps) {
	return {
		petWindowDrag: (_payload: { dx: number; dy: number }) => {
			// no-op until PetWindow and the pet feature register a handler
		},
	};
}
