export type GeneratedMediaKind = "image" | "video" | "audio";

export type GeneratedMediaItem = {
	id: string;
	kind: GeneratedMediaKind;
	provider: string;
	capability: string;
	title: string;
	path: string;
	url: string;
	contentType: string;
	bytes: number;
	createdAt: number;
	prompt?: string;
	model?: string;
	sourceUrl?: string;
};

export type GeneratedMediaList = {
	items: GeneratedMediaItem[];
	root: string;
};

export type MediaRequests = {
	mediaGalleryList: {
		params: {
			kind?: GeneratedMediaKind;
			provider?: string;
			limit?: number;
		};
		response: GeneratedMediaList;
	};
	mediaGalleryReveal: {
		params: { id: string };
		response: { ok: true };
	};
};
