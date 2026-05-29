/** Pure helpers for conditional image generation on original X posts.
 *  No vault, no process.env, no RPC, no plugin imports, no side effects. */

type NamedAction = { name: string };

function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h);
}

/** Capability-gated, deterministic: attach a generated image to about 1 in 5 original
 *  posts, only when an image-gen action is registered on the runtime. */
export function shouldAttachImage(draft: string, actions: NamedAction[]): boolean {
	const hasImageGen = actions.some((a) => a.name === "GENERATE_IMAGE");
	if (!hasImageGen || draft.trim().length === 0) return false;
	return hash(draft) % 5 === 0;
}

/** Turn a post draft into a short, literal image prompt. */
export function imagePromptFromDraft(draft: string): string {
	return `editorial illustration for a social post, no text in the image: ${draft.slice(0, 180)}`;
}
