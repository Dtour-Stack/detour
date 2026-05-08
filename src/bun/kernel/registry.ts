import type { KernelDeps } from "./app";

export interface Feature {
	id: string;
	init(deps: KernelDeps): void | Promise<void>;
}

export async function loadFeatures(
	deps: KernelDeps,
	features: Feature[],
): Promise<void> {
	for (const feature of features) {
		try {
			await feature.init(deps);
		} catch (err) {
			console.error(`Feature "${feature.id}" failed to initialise:`, err);
		}
	}
}
