import { useEffect, useState } from "react";
import type { WebClient } from "../api/client";

type Login = {
	source: "in-house" | "1password" | "bitwarden";
	identifier: string;
	domain?: string;
	username?: string;
	title?: string;
	updatedAt?: number;
};

type Result = {
	logins: Login[];
	failures: { source: string; message: string }[];
};

function displayLabel(l: Login): string {
	return l.title || l.domain || l.identifier;
}

function displayUsername(l: Login): string {
	if (!l.username) return "—";
	return l.username;
}

export function SavedLoginsTab({ client }: { client: WebClient }) {
	const [data, setData] = useState<Result | null>(null);
	const [revealing, setRevealing] = useState<Record<string, any>>({});
	const [filter, setFilter] = useState("");

	async function refresh() {
		const r = await client.listSavedLogins();
		setData(r as Result);
	}

	useEffect(() => {
		void refresh();
		const off = client.on((m) => {
			if (m.kind === "backend:changed") void refresh();
		});
		return off;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function reveal(login: Login) {
		const k = `${login.source}:${login.identifier}`;
		try {
			const r = await client.revealSavedLogin(login.source, login.identifier);
			setRevealing((s) => ({ ...s, [k]: r }));
		} catch (err) {
			setRevealing((s) => ({
				...s,
				[k]: { error: err instanceof Error ? err.message : String(err) },
			}));
		}
	}

	function hide(login: Login) {
		setRevealing((s) => {
			const k = `${login.source}:${login.identifier}`;
			const { [k]: _, ...rest } = s;
			return rest;
		});
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
	}

	if (!data) return <div className="hint">Loading…</div>;

	const filtered = data.logins.filter((l) => {
		if (!filter) return true;
		const q = filter.toLowerCase();
		return (
			(l.domain ?? "").toLowerCase().includes(q) ||
			(l.username ?? "").toLowerCase().includes(q) ||
			(l.title ?? "").toLowerCase().includes(q)
		);
	});

	const grouped: Record<string, Login[]> = {};
	for (const l of filtered) {
		(grouped[l.source] ??= []).push(l);
	}

	const totalCount = data.logins.length;

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Saved logins</h3>
			<p className="hint">
				Aggregated from your in-house vault and any signed-in password managers.
				Sign in via the <strong>Backends</strong> tab to see vendor entries.
			</p>

			{data.failures.length > 0 && (
				<div className="banner error">
					{data.failures.map((f) => (
						<div key={f.source}>
							<strong>{f.source}:</strong> {f.message}
						</div>
					))}
				</div>
			)}

			<input
				type="text"
				placeholder="Filter by domain, username, title…"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				style={{ marginBottom: 16, width: "100%" }}
			/>

			{totalCount === 0 && (
				<div className="empty">
					No saved logins yet. Sign in to a password manager from the{" "}
					<strong>Backends</strong> tab to see entries here.
				</div>
			)}

			{Object.entries(grouped).map(([source, logins]) => (
				<section key={source} style={{ paddingTop: 0 }}>
					<h3 style={{ marginBottom: 8 }}>
						{source} <span className="badge muted">{logins.length}</span>
					</h3>
					{logins.map((l) => {
						const k = `${l.source}:${l.identifier}`;
						const r = revealing[k];
						return (
							<div className="card" key={k}>
								<div className="provider-header">
									<span className="name">{displayLabel(l)}</span>
									<span className="badge muted">{displayUsername(l)}</span>
								</div>
								{r ? (
									r.error ? (
										<div>
											<div className="banner error" style={{ marginBottom: 8 }}>
												{r.error}
											</div>
											<button type="button" className="btn ghost small" onClick={() => hide(l)}>
												Dismiss
											</button>
										</div>
									) : (
										<div>
											{r.note && (
												<div className="banner warn" style={{ marginBottom: 8 }}>
													{r.note}
												</div>
											)}
											<div className="row" style={{ marginBottom: 6 }}>
												<input type="text" value={r.username ?? ""} readOnly placeholder="username" />
												<button
													type="button"
													className="btn secondary small"
													onClick={() => copy(r.username ?? "")}
												>
													Copy user
												</button>
											</div>
											{r.password ? (
												<div className="row" style={{ marginBottom: 6 }}>
													<input type="password" value={r.password} readOnly />
													<button
														type="button"
														className="btn secondary small"
														onClick={() => copy(r.password)}
													>
														Copy pwd
													</button>
													{r.totp && (
														<button
															type="button"
															className="btn secondary small"
															onClick={() => copy(r.totp)}
														>
															Copy TOTP
														</button>
													)}
												</div>
											) : r.totp ? (
												<div className="row" style={{ marginBottom: 6 }}>
													<input type="text" value={r.totp} readOnly placeholder="TOTP" />
													<button
														type="button"
														className="btn secondary small"
														onClick={() => copy(r.totp)}
													>
														Copy TOTP
													</button>
												</div>
											) : (
												<div className="hint" style={{ marginBottom: 6 }}>
													No password / TOTP available for this item.
												</div>
											)}
											<button type="button" className="btn ghost small" onClick={() => hide(l)}>
												Hide
											</button>
										</div>
									)
								) : (
									<button type="button" className="btn small" onClick={() => reveal(l)}>
										Reveal
									</button>
								)}
							</div>
						);
					})}
				</section>
			))}

			{filtered.length === 0 && totalCount > 0 && (
				<div className="hint">No saved logins match the filter.</div>
			)}
		</div>
	);
}
