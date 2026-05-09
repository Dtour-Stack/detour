import { Utils } from "electrobun/bun";
import type { RpcDeps } from "../types";

/**
 * System browser passthrough — uses electrobun's Utils.openExternal so OAuth
 * flows can reach the user's default browser. Replaces POST /api/external/open.
 *
 * URL validation matches the legacy HTTP handler: only http(s) is allowed.
 */
export function externalRequests(_deps: RpcDeps) {
	return {
		externalOpen: async (params: { url: string }): Promise<{ ok: true }> => {
			if (typeof params.url !== "string" || !/^https?:\/\//i.test(params.url)) {
				throw new Error("invalid url");
			}
			Utils.openExternal(params.url);
			return { ok: true };
		},
	};
}
