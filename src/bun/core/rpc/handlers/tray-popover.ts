/**
 * Tray-popover window drag + hide handlers — follows the same
 * pattern as capsule.ts so the dashboard can be repositioned.
 */

type DragHandler = (payload: { dx: number; dy: number }) => void;

let dragHandler: DragHandler | null = null;
let hideHandler: (() => void) | null = null;

export function setTrayPopoverDragHandler(next: DragHandler | null): void {
	dragHandler = next;
}

export function setTrayPopoverHideHandler(next: (() => void) | null): void {
	hideHandler = next;
}

export function trayPopoverRequests() {
	return {
		trayPopoverHide: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			hideHandler?.();
			return { ok: true };
		},
	};
}

export function trayPopoverMessages() {
	return {
		trayPopoverDrag: (payload: { dx: number; dy: number }) => {
			if (!Number.isFinite(payload.dx) || !Number.isFinite(payload.dy)) return;
			dragHandler?.({ dx: payload.dx, dy: payload.dy });
		},
	};
}
