/**
 * Injects the agent's self-distilled trajectory lessons into its context.
 *
 * The Phase 2 `TrajectoryLearningService` (core) distills recent rewarded
 * trajectories into a bounded, update-in-place markdown file. This provider
 * reads that file and surfaces it every turn, so the agent acts on what it has
 * learned. Reader and writer are decoupled through the file path (the contract)
 * — the provider does not import the core service.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, Provider, ProviderResult } from "@elizaos/core";

const LESSONS_PATH = join(homedir(), ".detour", "trajectory-lessons.md");

function readLessons(): string | null {
	try {
		return existsSync(LESSONS_PATH) ? readFileSync(LESSONS_PATH, "utf8").trim() || null : null;
	} catch {
		return null;
	}
}

export const trajectoryLessonsProvider: Provider = {
	name: "TRAJECTORY_LESSONS",
	description:
		"Lessons the agent has distilled from its own past action trajectories — patterns to repeat, patterns to avoid, and skill adjustments. Auto-updated by the trajectory-learning loop.",
	descriptionCompressed: "self-distilled lessons from past trajectories.",
	position: -20,
	get: async (): Promise<ProviderResult> => {
		const lessons = readLessons();
		if (!lessons) return { text: "", values: {} as never, data: {} as never };
		return {
			text: `# Lessons from your own past trajectories\n${lessons}`,
			values: { hasTrajectoryLessons: true } as never,
			data: {} as never,
		};
	},
};

export const trajectoryLessonsPlugin: Plugin = {
	name: "trajectory-lessons",
	description:
		"Surfaces self-distilled trajectory lessons into the agent's context so it learns from its own past behavior (Phase 2 learn-over loop).",
	providers: [trajectoryLessonsProvider],
};

export default trajectoryLessonsPlugin;
