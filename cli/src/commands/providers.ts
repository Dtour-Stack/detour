import type { ProviderId } from "@detour/shared";
import type { CliClient } from "../client";

export async function listProviders(client: CliClient): Promise<void> {
	const providers = await client.listProviders();
	if (providers.length === 0) {
		console.log("(no providers)");
		return;
	}
	for (const p of providers) {
		const tag = p.active ? "[ACTIVE]" : p.hasKey ? "[ready]" : "[no key]";
		console.log(`  ${tag.padEnd(10)} ${p.id.padEnd(12)} ${p.label}`);
	}
}

export async function setProviderKey(
	client: CliClient,
	id: ProviderId,
	key: string,
): Promise<void> {
	await client.setProviderKey(id, key);
	console.log(`stored key for ${id}`);
}

export async function setActiveProvider(
	client: CliClient,
	id: ProviderId,
): Promise<void> {
	await client.setActiveProvider(id);
	console.log(`active provider → ${id}`);
}

export async function removeProviderKey(
	client: CliClient,
	id: ProviderId,
): Promise<void> {
	await client.removeProviderKey(id);
	console.log(`removed key for ${id}`);
}
