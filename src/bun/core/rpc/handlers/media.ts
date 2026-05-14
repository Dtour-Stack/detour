import type { MediaRequests } from "../../../../shared/rpc/media";
import { listGeneratedMedia, revealGeneratedMedia } from "../../generated-media";
import type { RpcDeps } from "../types";

export function mediaRequests(_deps: RpcDeps): {
	[K in keyof MediaRequests]: (params: MediaRequests[K]["params"]) => Promise<MediaRequests[K]["response"]>;
} {
	return {
		mediaGalleryList: async (params) => listGeneratedMedia(params),
		mediaGalleryReveal: async (params) => {
			await revealGeneratedMedia(params.id);
			return { ok: true };
		},
	};
}
