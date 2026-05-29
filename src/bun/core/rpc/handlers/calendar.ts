/**
 * Calendar RPC handlers — 3 endpoints for the calendar view.
 *
 *   - calendarEvents          → list events in a date range
 *   - calendarEventDetails    → full details for a specific event
 *   - calendarSync            → trigger on-demand Earn scan
 */

import type { RpcDeps } from "../types";
import type {
	EarnCalendarEvent,
	EarnScanSummary,
} from "../../../../shared/index";

export function calendarRequests(deps: RpcDeps) {
	return {
		calendarEvents: async (
			params: { start?: string; end?: string },
		): Promise<EarnCalendarEvent[]> => {
			if (!deps.earnScanner) return [];
			if (params.start && params.end) {
				return deps.earnScanner.getEventsInRange(params.start, params.end);
			}
			return deps.earnScanner.getCachedEvents();
		},

		calendarEventDetails: async (
			params: { slug: string },
		): Promise<{
			event: EarnCalendarEvent | null;
			scanSummary: EarnScanSummary | null;
		}> => {
			if (!deps.earnScanner) return { event: null, scanSummary: null };
			const events = deps.earnScanner.getCachedEvents();
			const event = events.find((e) => e.slug === params.slug) ?? null;
			return {
				event,
				scanSummary: deps.earnScanner.getLastScan(),
			};
		},

		calendarSync: async (
			_params: Record<string, never>,
		): Promise<EarnScanSummary | null> => {
			if (!deps.earnScanner) return null;
			return deps.earnScanner.scan();
		},

		calendarScanSummary: async (
			_params: Record<string, never>,
		): Promise<EarnScanSummary | null> => {
			if (!deps.earnScanner) return null;
			return deps.earnScanner.getLastScan();
		},
	};
}
