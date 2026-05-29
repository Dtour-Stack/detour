export type CapsuleRequests = {
	capsuleNotify: {
		params: { title: string; body?: string; subtitle?: string };
		response: { ok: true };
	};
	capsuleHide: {
		params: Record<string, never>;
		response: { ok: true };
	};
};

export type CapsuleMessages = {
	capsuleWindowDrag: { dx: number; dy: number };
};
