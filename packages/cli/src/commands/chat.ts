import { CliClient } from "../client";

export async function runChat(client: CliClient): Promise<void> {
	const providers = await client.listProviders();
	const active = providers.find((p) => p.active);
	if (!active) {
		console.error("No active provider. Run `detour providers` to configure one.");
		process.exit(1);
	}
	console.log(`Connected — chatting via ${active.label}.`);
	console.log("Type 'exit' or Ctrl+C to quit.\n");

	const convId = `cli-${Date.now()}`;
	let pendingResolve: (() => void) | null = null;
	let firstDelta = true;

	client.on((msg) => {
		if (msg.kind === "chat:delta" && msg.convId === convId) {
			if (firstDelta) {
				process.stdout.write("Eliza: ");
				firstDelta = false;
			}
			process.stdout.write(msg.delta);
		} else if (msg.kind === "chat:complete" && msg.convId === convId) {
			process.stdout.write("\n\n");
			firstDelta = true;
			pendingResolve?.();
			pendingResolve = null;
		} else if (msg.kind === "chat:error" && msg.convId === convId) {
			console.error(`\nError: ${msg.message}\n`);
			firstDelta = true;
			pendingResolve?.();
			pendingResolve = null;
		}
	});

	for await (const line of console) {
		const text = line.trim();
		if (!text) continue;
		if (text === "exit" || text === "quit") break;
		await new Promise<void>((resolve) => {
			pendingResolve = resolve;
			client.send({ kind: "chat:send", convId, text });
		});
	}
	client.close();
}
