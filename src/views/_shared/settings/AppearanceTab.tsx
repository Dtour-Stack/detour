import { useEffect, useState } from "react";
import type { ThemeChoice } from "../../../shared/index";
import type { WebClient } from "../api/client";

const ACCENTS = [
	{ name: "Blue", value: "#0a84ff" },
	{ name: "Purple", value: "#bf5af2" },
	{ name: "Pink", value: "#ff375f" },
	{ name: "Orange", value: "#ff9f0a" },
	{ name: "Green", value: "#30d158" },
	{ name: "Teal", value: "#64d2ff" },
	{ name: "Indigo", value: "#5e5ce6" },
	{ name: "Yellow", value: "#ffd60a" },
];

function applyTheme(t: ThemeChoice) {
	if (t === "system") document.documentElement.removeAttribute("data-theme");
	else document.documentElement.setAttribute("data-theme", t);
}
function applyAccent(a: string) {
	document.documentElement.style.setProperty("--accent", a);
}

export function AppearanceTab({ client }: { client: WebClient }) {
	const [theme, setTheme] = useState<ThemeChoice>("system");
	const [accent, setAccent] = useState("#0a84ff");

	useEffect(() => {
		void client.getUiPreferences().then((p) => {
			setTheme((p.theme ?? "system") as ThemeChoice);
			setAccent(p.accent ?? "#0a84ff");
		});
	}, [client]);

	function changeTheme(t: ThemeChoice) {
		setTheme(t);
		applyTheme(t);
		void client.setUiPreferences({ theme: t });
	}
	function changeAccent(a: string) {
		setAccent(a);
		applyAccent(a);
		void client.setUiPreferences({ accent: a });
	}

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Appearance</h3>
			<p className="hint">Theme + accent color. Persists across sessions.</p>
			<div className="card">
				<label>Theme</label>
				<div className="theme-toggle" style={{ marginTop: 6, marginBottom: 14 }}>
					{(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
						<button
							key={t}
							type="button"
							className={theme === t ? "active" : ""}
							onClick={() => changeTheme(t)}
						>
							{t}
						</button>
					))}
				</div>
				<label>Accent color</label>
				<div className="accent-picker" style={{ padding: 0, marginTop: 6 }}>
					{ACCENTS.map((s) => (
						<button
							key={s.value}
							type="button"
							className={accent === s.value ? "accent-swatch active" : "accent-swatch"}
							style={{ background: s.value }}
							title={s.name}
							onClick={() => changeAccent(s.value)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
