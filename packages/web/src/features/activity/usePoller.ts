import { useEffect, useRef, useState } from "react";

/**
 * Minimal poller — calls `fetcher` on mount, every `intervalMs`, and again
 * whenever any element of `deps` changes. Pauses while the document is
 * hidden (visibilitychange) so backgrounded Pensieve windows don't churn.
 *
 * Returns the latest result + loading + error states. Use refresh() to
 * trigger an out-of-band fetch (e.g. after a mutation).
 */
export function usePoller<T>(
	fetcher: () => Promise<T>,
	intervalMs = 5000,
	deps: ReadonlyArray<unknown> = [],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const inflight = useRef(false);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		async function tick() {
			if (cancelled || inflight.current || document.hidden) {
				timer = setTimeout(tick, intervalMs);
				return;
			}
			inflight.current = true;
			setLoading(true);
			try {
				const result = await fetcher();
				if (!cancelled) {
					setData(result);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			} finally {
				inflight.current = false;
				if (!cancelled) setLoading(false);
				timer = setTimeout(tick, intervalMs);
			}
		}

		void tick();
		const onVisibility = () => { if (!document.hidden) void tick(); };
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [intervalMs, ...deps]);

	const refresh = () => {
		inflight.current = false;
		(async () => {
			try {
				setLoading(true);
				const r = await fetcher();
				setData(r);
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		})();
	};

	return { data, error, loading, refresh };
}
