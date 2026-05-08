import type { CliClient, RuntimeLock } from "../client";

export async function showStatus(
	client: CliClient,
	lock: RuntimeLock,
): Promise<void> {
	const health = await client.health();
	console.log(`agent      v${health.version}`);
	console.log(`port       ${lock.port}`);
	console.log(`pid        ${lock.pid}`);
	console.log(`started    ${lock.startedAt}`);
}
