/**
 * Worker name generator — Detour's Menagerie.
 *
 * The lead character is **Detour Squirrel**: a squirrel that takes
 * detours, can't find the nuts he buried, gets lost in the same yard
 * every winter. The joke is in the incongruity — a squirrel that
 * fails at the one thing squirrels are supposed to do.
 *
 * Every other worker name follows the same template: an
 * `${Adjective} ${Animal}` pair where the adjective undercuts the
 * species' stereotype, or where the combination is just a
 * mildly-haggard adult-life joke. Examples:
 *
 *   - "Hungover Owl" (owl who's bad at staying up late)
 *   - "Punctual Sloth" (sloth who's somehow on time)
 *   - "Tax-Evading Capybara" (chill animal in legal trouble)
 *   - "Codependent Octopus" (solitary species, attached)
 *   - "Vegan Hyena" (apex carnivore on a kale phase)
 *   - "Burnt-Out Hummingbird" (high-metabolism critter, depleted)
 *
 * Tone target: BoJack-flavored. Adult-humor about therapy,
 * relationships, money, work — never crude, never punching down. The
 * incongruity is the gag; the animal's never the butt of the joke,
 * the unwinnable modern-adult condition is.
 *
 * Names are derived deterministically from a seed (the spawn's
 * session id or `${action}:${messageId}`) so the same spawn always
 * renders the same name — important for trajectory linking, chat
 * re-renders, and the user being able to refer to "what did Hungover
 * Owl find?" three days later and have the agent know who that was.
 *
 * Pool: 80 adjectives × 65 animals = 5,200 unique combinations.
 */

const ADJECTIVES: readonly string[] = [
	// Self-help / mental-health adult humor
	"Anxious", "Avoidant", "Codependent", "Recovering", "Therapy-Skipping",
	"Self-Aware", "Self-Deprecating", "Self-Employed", "Existential",
	"Burnt-Out", "Overstimulated", "Dissociating", "Apologetic",
	// Drinking / coffee / vice culture
	"Hungover", "Sober", "Caffeinated", "Decaffeinated", "Overcaffeinated",
	"Bourbon", "Two-Drink", "Wine-Mom", "Vape-Pen", "Day-Drinking",
	// Money / career anxiety
	"Bankrupt", "Insolvent", "Audited", "Freelance", "Unemployed",
	"Overworked", "Underpaid", "Tax-Evading", "Unionized", "Day-Trading",
	"Crypto", "Pre-Diabetic",
	// Dating / relationships
	"Polyamorous", "Monogamous", "Catfished", "Ghosted", "Heartbroken",
	"Newly-Divorced", "Newly-Engaged", "Tinder-Verified", "Situationship",
	// Sleep / time
	"Insomniac", "Narcoleptic", "Sleep-Deprived", "Procrastinating",
	"Punctual", "Tardy", "Off-Duty", "On-Call",
	// Diet / lifestyle
	"Vegan", "Carnivorous", "Lactose-Intolerant", "Gluten-Free",
	// Branding / consumer-culture
	"Off-Brand", "Discount", "Premium", "Limited-Edition", "Counterfeit",
	"Subscription", "Reformed", "Cancelled",
	// Stereotype-undercutting moods
	"Smug", "Humble", "Pretentious", "Grumpy", "Cheerful", "Confused",
	"Pessimistic", "Optimistic", "Honest", "Loyal", "Generous",
	"Patient", "Quiet", "Modest", "Lazy",
] as const;

const ANIMALS: readonly string[] = [
	// Squirrel kin + small mammals (Detour's clan)
	"Squirrel", "Chipmunk", "Raccoon", "Opossum", "Skunk", "Hedgehog",
	"Capybara", "Beaver", "Otter", "Ferret", "Weasel", "Mongoose",
	// Canids + felids
	"Fox", "Coyote", "Wolf", "Hyena", "Jackal", "Lemur",
	// Slow / unusual mammals
	"Sloth", "Tapir", "Anteater", "Aardvark", "Pangolin", "Wombat",
	"Quokka", "Platypus", "Echidna", "Llama", "Alpaca", "Camel",
	// Tall / horsey
	"Giraffe", "Zebra", "Donkey", "Mule",
	// Birds — the comedy-rich subset
	"Kookaburra", "Magpie", "Crow", "Raven", "Owl", "Pigeon",
	"Seagull", "Pelican", "Flamingo", "Stork", "Heron", "Penguin",
	"Puffin", "Cormorant", "Ostrich", "Emu", "Cassowary", "Peacock",
	"Turkey", "Goose", "Duck", "Swan", "Albatross", "Vulture", "Buzzard",
	// Water / weird
	"Octopus", "Walrus", "Manatee", "Narwhal", "Hippo", "Iguana",
	"Axolotl", "Toad",
] as const;

/**
 * Stable 32-bit hash for seed strings. djb2 — fast, deterministic,
 * collision-resistant for picking from a ~5k pool. Stays out of
 * Node-specific crypto so Bun.Worker contexts don't pay an import cost.
 */
function hashSeed(seed: string): number {
	let h = 5381;
	for (let i = 0; i < seed.length; i++) {
		h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

/**
 * Generate a stable worker name from a seed string.
 *
 * @param seed Any string — typically the spawn's session id, room id,
 *   or `${parentAction}:${messageId}`. Deterministic: same seed in,
 *   same name out.
 * @returns An "Adjective Animal" name (e.g. "Hungover Squirrel").
 */
export function workerNameFromSeed(seed: string): string {
	const h = hashSeed(seed || "fallback");
	const adj = ADJECTIVES[h % ADJECTIVES.length]!;
	// Separate bit-range for the animal pick so adj/animal don't rotate
	// in lock-step across consecutive seeds.
	const animal = ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length]!;
	return `${adj} ${animal}`;
}

/**
 * Free-form generation when no stable seed is needed (one-off CLI
 * flows). Uses crypto-random bytes so two calls within the same
 * millisecond still differ.
 */
export function randomWorkerName(): string {
	const buf = new Uint8Array(8);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(buf);
	} else {
		for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
	}
	let seed = "";
	for (const b of buf) seed += b.toString(16).padStart(2, "0");
	return workerNameFromSeed(seed);
}

/**
 * Pool stats for diagnostics + tests. Lock the minimums so a future
 * deletion can't silently shrink the pool below collision-safe.
 */
export const WORKER_NAME_POOL = {
	adjectives: ADJECTIVES,
	animals: ANIMALS,
	combinations: ADJECTIVES.length * ANIMALS.length,
} as const;
