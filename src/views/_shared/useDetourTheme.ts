import { useEffect } from "react";
import type { ThemeChoice, UiPreferences } from "@detour/shared";
import { WebClient } from "./api/client";

const DEFAULT_ACCENT = "#0a84ff";

function applyTheme(theme: ThemeChoice): void {
	if (theme === "system") {
		document.documentElement.removeAttribute("data-theme");
	} else {
		document.documentElement.setAttribute("data-theme", theme);
	}
}

function applyAccent(accent: string): void {
	document.documentElement.style.setProperty("--accent", accent);
}

function applyPrefs(p: Partial<UiPreferences>): void {
	applyTheme((p.theme ?? "system") as ThemeChoice);
	applyAccent(p.accent ?? DEFAULT_ACCENT);
}

/**
 * Load the user's UI preferences once and re-apply on live changes.
 *
 * Called from every top-level window (chat App, PensieveView, ActivityView,
 * ChannelsView). Without this, themes set in Settings only affect the chat
 * popup — Pensieve/Activity/Channels keep the default colors because each
 * window owns its own DOM.
 *
 * Server broadcasts `ui:preferences-changed` whenever any window saves new
 * preferences via PUT /api/ui/preferences, so other open windows update
 * live without needing a reload.
 */
export function useDetourTheme(client: WebClient): void {
	useEffect(() => {
		let cancelled = false;
		client
			.getUiPreferences()
			.then((p) => {
				if (cancelled) return;
				applyPrefs(p);
			})
			.catch(() => {
				/* keep default colors */
			});
		const off = client.on((m) => {
			if (m.kind === "ui:preferences-changed") applyPrefs(m.preferences);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, [client]);
}
