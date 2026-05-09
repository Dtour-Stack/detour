import { useEffect } from "react";
import type { ThemeChoice, UiPreferences } from "../shared/index";
import { rpc } from "./rpc";
import { onUiPreferencesChanged } from "./rpc-listeners/config";

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
 * Server broadcasts `uiPreferencesChanged` (typed RPC) whenever any window
 * saves new preferences, so other open windows update live without a reload.
 */
export function useDetourTheme(): void {
	useEffect(() => {
		let cancelled = false;
		rpc.request
			.uiGetPreferences({})
			.then((p) => {
				if (cancelled) return;
				applyPrefs(p);
			})
			.catch(() => {
				/* keep default colors */
			});
		const off = onUiPreferencesChanged((payload) => applyPrefs(payload.preferences));
		return () => {
			cancelled = true;
			off();
		};
	}, []);
}
