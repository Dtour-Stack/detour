type Listener<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
	private listeners = new Map<keyof Events, Set<Listener<unknown>>>();

	on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
		const set = this.listeners.get(event) ?? new Set();
		set.add(listener as Listener<unknown>);
		this.listeners.set(event, set);
		return () => set.delete(listener as Listener<unknown>);
	}

	emit<K extends keyof Events>(event: K, payload: Events[K]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const listener of set) (listener as Listener<Events[K]>)(payload);
	}
}

export type KernelEvents = {
	"provider:changed": { activeProvider: string | null };
	"runtime:ready": Record<string, never>;
	"runtime:error": { message: string };
	"ui:open-settings": Record<string, never>;
	"ui:open-chat": Record<string, never>;
	"ui:toggle-chat": Record<string, never>;
	"ui:open-pensieve": Record<string, never>;
	"ui:open-activity": Record<string, never>;
	notify: { title: string; body?: string; subtitle?: string };
};
