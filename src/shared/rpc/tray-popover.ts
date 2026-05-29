export type TrayPopoverRequests = {
	trayPopoverHide: {
		params: Record<string, never>;
		response: { ok: true };
	};
};

export type TrayPopoverMessages = {
	trayPopoverDrag: { dx: number; dy: number };
};
