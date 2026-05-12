import { BrowserView } from "electrobun/bun";
import type { DetourRPC } from "../../../shared/rpc";

export type DetourViewRpcClient = ReturnType<typeof BrowserView.defineRPC<DetourRPC>>;

const viewRpcClients = new Set<DetourViewRpcClient>();

export function registerViewRpcClient(client: DetourViewRpcClient): () => void {
	viewRpcClients.add(client);
	return () => viewRpcClients.delete(client);
}

type WebviewRequestName = keyof DetourRPC["webview"]["requests"];

/**
 * Call the first webview that successfully handles the request. Used when
 * the Bun side needs Phantom (or other view-only) work while any Detour
 * window may be open.
 */
export async function invokeFirstViewRequest<N extends WebviewRequestName>(
	method: N,
	params: DetourRPC["webview"]["requests"][N] extends { params: infer P } ? P : never,
): Promise<
	DetourRPC["webview"]["requests"][N] extends { response: infer R } ? R : never
> {
	const errors: string[] = [];
	for (const client of viewRpcClients) {
		try {
			const fn = (client.request as unknown as Record<string, (p: unknown) => Promise<unknown>>)[
				method as string
			];
			if (!fn) continue;
			return (await fn(params)) as never;
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}
	throw new Error(
		errors.length > 0
			? `phantom: no webview handled ${String(method)}: ${errors.join(" | ")}`
			: `phantom: no open webview for ${String(method)}`,
	);
}
