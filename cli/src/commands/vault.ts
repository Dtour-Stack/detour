import type { CliClient } from "../client";

export async function listInventory(client: CliClient): Promise<void> {
	const items = (await client.listVaultInventory()) as Array<{
		key: string;
		category: string;
		kind?: string;
		provider?: string | null;
	}>;
	const stats = await client.vaultStats();
	console.log(
		`${stats.total} entries · ${stats.sensitive} sensitive · ${stats.nonSensitive} config · ${stats.references} refs\n`,
	);
	for (const item of items) {
		const cat = `[${item.category}]`.padEnd(14);
		console.log(`  ${cat} ${item.key}${item.provider ? ` (${item.provider})` : ""}`);
	}
}

export async function getKey(client: CliClient, key: string): Promise<void> {
	const r = await client.getVaultKey(key, true);
	if (r.value == null) {
		console.error(`Key not found: ${key}`);
		process.exit(1);
	}
	process.stdout.write(`${r.value}\n`);
}

export async function setKey(
	client: CliClient,
	key: string,
	value: string,
	sensitive = true,
): Promise<void> {
	await client.setVaultKey(key, value, sensitive);
	console.log(`stored: ${key}`);
}

export async function removeKey(client: CliClient, key: string): Promise<void> {
	await client.removeVaultKey(key);
	console.log(`removed: ${key}`);
}

export async function listLogins(client: CliClient): Promise<void> {
	const r = await client.listSavedLogins();
	if (r.failures.length > 0) {
		for (const f of r.failures) console.error(`  [${f.source}] ${f.message}`);
	}
	const grouped: Record<string, any[]> = {};
	for (const l of r.logins) (grouped[l.source] ??= []).push(l);
	for (const [source, logins] of Object.entries(grouped)) {
		console.log(`\n${source} (${logins.length}):`);
		for (const l of logins) {
			const handle = l.title || l.domain || l.identifier;
			const user = l.username ? ` — ${l.username}` : "";
			console.log(`  ${handle}${user}`);
		}
	}
}

export async function revealLogin(
	client: CliClient,
	source: string,
	identifier: string,
): Promise<void> {
	const r = await client.revealSavedLogin(source, identifier);
	console.log(`username: ${r.username ?? "—"}`);
	console.log(`password: ${r.password ?? "—"}`);
	if (r.totp) console.log(`totp:     ${r.totp}`);
	if (r.domain) console.log(`domain:   ${r.domain}`);
}

export async function listBackends(client: CliClient): Promise<void> {
	const backends = (await client.getBackends()) as Array<{
		id: string;
		label: string;
		available: boolean;
		signedIn?: boolean;
		detail?: string;
	}>;
	for (const b of backends) {
		const status = !b.available
			? "[not installed]"
			: b.signedIn === false
				? "[signed out]"
				: "[ready]";
		console.log(`  ${status.padEnd(18)} ${b.id.padEnd(12)} ${b.label}`);
		if (b.detail) console.log(`  ${"".padEnd(18)} ${b.detail}`);
	}
}
