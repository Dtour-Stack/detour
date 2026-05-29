import { Utils } from "electrobun/bun";
import { logger } from "@elizaos/core";

type DragHandler = (payload: { dx: number; dy: number }) => void;

let dragHandler: DragHandler | null = null;
let hideHandler: (() => void) | null = null;

export function setCapsuleWindowDragHandler(next: DragHandler | null): void {
	dragHandler = next;
}

export function setCapsuleWindowHideHandler(next: (() => void) | null): void {
	hideHandler = next;
}

export function capsuleRequests() {
	return {
		capsuleNotify: async (params: { title: string; body?: string; subtitle?: string }): Promise<{ ok: true }> => {
			if (!params.title.trim()) throw new Error("title required");
			try {
				Utils.showNotification({
					title: params.title,
					...(params.body ? { body: params.body } : {}),
					...(params.subtitle ? { subtitle: params.subtitle } : {}),
				});
			} catch (err) {
				logger.warn({ src: "capsule", err: err instanceof Error ? err.message : String(err) }, "[Capsule] notification failed");
			}
			return { ok: true };
		},
		capsuleHide: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			hideHandler?.();
			return { ok: true };
		},
	};
}

export function capsuleMessages() {
	return {
		capsuleWindowDrag: (payload: { dx: number; dy: number }) => {
			if (!Number.isFinite(payload.dx) || !Number.isFinite(payload.dy)) return;
			dragHandler?.({ dx: payload.dx, dy: payload.dy });
		},
	};
}
