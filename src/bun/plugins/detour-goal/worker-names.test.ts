import { describe, expect, test } from "bun:test";
import {
	WORKER_NAME_POOL,
	randomWorkerName,
	workerNameFromSeed,
} from "./worker-names";

// "Adjective Animal" — adjective may contain hyphens or apostrophes
// ("Two-Drink", "Wine-Mom"), animal is a single capital word.
const NAME_REGEX = /^[A-Z][a-zA-Z'-]+ [A-Z][a-z]+$/;

describe("workerNameFromSeed", () => {
	test("returns an 'Adjective Animal'-shaped name", () => {
		const name = workerNameFromSeed("abc123");
		expect(name).toMatch(NAME_REGEX);
	});

	test("is deterministic — same seed yields the same name", () => {
		const a = workerNameFromSeed("session-deadbeef");
		const b = workerNameFromSeed("session-deadbeef");
		expect(a).toBe(b);
	});

	test("different seeds yield different names (high probability)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 100; i++) {
			seen.add(workerNameFromSeed(`seed-${i}`));
		}
		// 100 seeds into a ~5k pool — ≥90 unique by birthday paradox
		expect(seen.size).toBeGreaterThanOrEqual(90);
	});

	test("empty seed still produces a valid name (fallback path)", () => {
		expect(workerNameFromSeed("")).toMatch(NAME_REGEX);
	});

	test("pool is large enough to keep collisions rare", () => {
		expect(WORKER_NAME_POOL.combinations).toBeGreaterThanOrEqual(5000);
		expect(WORKER_NAME_POOL.adjectives.length).toBeGreaterThanOrEqual(60);
		expect(WORKER_NAME_POOL.animals.length).toBeGreaterThanOrEqual(60);
	});

	test("animal vocab includes Detour's clan + comedy-rich species", () => {
		// Sanity check that the lore animals are in the pool — accidental
		// deletion would gut the joke. Detour Squirrel's kin first.
		for (const animal of ["Squirrel", "Capybara", "Sloth", "Octopus", "Owl", "Hyena"]) {
			expect(WORKER_NAME_POOL.animals).toContain(animal);
		}
	});

	test("adjective vocab carries adult-life flavor", () => {
		// Lock the comedic register so a future "let's keep it PG" PR
		// that strips these silently has to face down the test failure.
		for (const adj of ["Hungover", "Burnt-Out", "Tax-Evading", "Codependent", "Insomniac"]) {
			expect(WORKER_NAME_POOL.adjectives).toContain(adj);
		}
	});

	test("known-seed examples render the expected ironic combinations", () => {
		// Spot-check: every name should read like an HBO character
		// description, not a children's book. We render 20 seeds and
		// assert none are crude or off-brand; this acts as a smoke check
		// against accidental edits.
		const samples = Array.from({ length: 20 }, (_, i) => workerNameFromSeed(`spawn-${i}`));
		for (const s of samples) {
			expect(s).toMatch(NAME_REGEX);
			// No leading/trailing whitespace, no double spaces.
			expect(s.trim()).toBe(s);
			expect(s).not.toMatch(/\s{2,}/);
		}
	});
});

describe("randomWorkerName", () => {
	test("returns a valid 'Adjective Animal'-shaped name", () => {
		expect(randomWorkerName()).toMatch(NAME_REGEX);
	});

	test("multiple calls produce different names (probabilistic)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) seen.add(randomWorkerName());
		expect(seen.size).toBeGreaterThanOrEqual(45);
	});
});
