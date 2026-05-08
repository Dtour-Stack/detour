import { ModelType, type Plugin } from "@elizaos/core";

const DIM = 1536; // matches text-embedding-3-small / common runtime expectation
const ZERO_VEC = new Array(DIM).fill(0);

/**
 * Minimal no-op embeddings plugin so the runtime doesn't error with
 * "No handler found for delegate type: TEXT_EMBEDDING" when only
 * plugin-anthropic / a future Codex plugin is loaded (neither provides
 * embeddings via subscription auth).
 *
 * Memory storage that depends on real semantic embeddings will degrade,
 * but chat itself stays functional. Replace with a real embeddings provider
 * (plugin-openai with API key, or local Llama embeddings) for production.
 */
export const embeddingStubPlugin: Plugin = {
	name: "embedding-stub",
	description: "Zero-vector embeddings stub for runtimes without an embeddings provider",
	models: {
		[ModelType.TEXT_EMBEDDING]: async () => {
			return ZERO_VEC;
		},
	},
};
