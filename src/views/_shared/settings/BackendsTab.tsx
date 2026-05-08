import { useEffect, useState } from "react";
import type { BackendStatus, OpDiagnostic } from "@detour/shared";
import type { WebClient } from "../api/client";

type InstallSpec = {
	id: string;
	methods: { kind: string; package?: string; cask?: boolean; url?: string; instructions?: string }[];
	commands: ({ command: string; args: string[] } | null)[];
};

type View = { kind: "list" } | { kind: "detail"; backendId: string };

export function BackendsTab({ client }: { client: WebClient }) {
	const [backends, setBackends] = useState<BackendStatus[]>([]);
	const [enabled, setEnabled] = useState<string[]>([]);
	const [install, setInstall] = useState<{ platform: string; specs: InstallSpec[] } | null>(null);
	const [view, setView] = useState<View>({ kind: "list" });

	async function refresh() {
		const [b, e, i] = await Promise.all([
			client.detectBackends().catch(() => [] as BackendStatus[]),
			client.getEnabledBackends().catch(() => [] as string[]),
			client.getBackendInstall().catch(() => null),
		]);
		setBackends(b);
		setEnabled(e);
		setInstall(i);
	}

	useEffect(() => {
		void refresh();
		const off = client.on((m) => {
			if (m.kind === "backend:changed") void refresh();
		});
		return off;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function toggle(id: string, on: boolean) {
		const next = on
			? Array.from(new Set([...enabled, id]))
			: enabled.filter((x) => x !== id);
		await client.setEnabledBackends(["in-house", ...next.filter((x) => x !== "in-house")]);
		await refresh();
	}

	const enabledSet = new Set(enabled);

	if (view.kind === "detail") {
		const backend = backends.find((b) => b.id === view.backendId);
		if (!backend) {
			return (
				<div>
					<button type="button" className="back-btn" onClick={() => setView({ kind: "list" })}>
						← Back
					</button>
					<div className="empty">Backend not found.</div>
				</div>
			);
		}
		return (
			<BackendDetail
				client={client}
				backend={backend}
				install={install}
				onBack={() => setView({ kind: "list" })}
				onChange={refresh}
			/>
		);
	}

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Storage backends</h3>
			<p className="hint">
				Default: encrypted local vault (master key in OS keychain). Click a backend
				to view diagnostics, sign in, or sign out.
			</p>

			{backends.map((b) => {
				const isOn = enabledSet.has(b.id);
				const tone = !b.available
					? "err"
					: b.signedIn === false
						? "warn"
						: isOn
							? "ok"
							: "muted";
				const status = !b.available
					? "Not installed"
					: b.signedIn === false
						? "Signed out"
						: isOn
							? "Enabled"
							: "Available";
				return (
					<div
						className={`card ${b.id !== "in-house" ? "clickable" : ""}`}
						key={b.id}
						onClick={
							b.id !== "in-house" ? () => setView({ kind: "detail", backendId: b.id }) : undefined
						}
					>
						<div className="provider-header" style={{ marginBottom: b.detail || b.id === "in-house" ? 8 : 0 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span className="name">{b.label}</span>
								<span className={`badge ${tone}`}>{status}</span>
								{b.authMode === "desktop-app" && (
									<span className="badge info">via desktop app</span>
								)}
							</div>
							{b.id === "in-house" ? (
								<span style={{ fontSize: 11, color: "var(--fg-muted)" }}>Always on</span>
							) : (
								<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
									<label
										style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0, display: "flex", alignItems: "center", gap: 4 }}
										onClick={(e) => e.stopPropagation()}
									>
										<input
											type="checkbox"
											checked={isOn}
											disabled={!b.available || b.signedIn === false}
											onChange={(e) => {
												e.stopPropagation();
												void toggle(b.id, e.target.checked);
											}}
										/>
										Use
									</label>
									<span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>›</span>
								</div>
							)}
						</div>
						{b.detail && (
							<div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{b.detail}</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

function BackendDetail({
	client,
	backend,
	install,
	onBack,
	onChange,
}: {
	client: WebClient;
	backend: BackendStatus;
	install: { platform: string; specs: InstallSpec[] } | null;
	onBack: () => void;
	onChange: () => Promise<void>;
}) {
	const [diag, setDiag] = useState<OpDiagnostic | null>(null);
	const [diagLoading, setDiagLoading] = useState(false);
	const [diagOpen, setDiagOpen] = useState(false);

	async function runDiagnose() {
		if (backend.id !== "1password") return;
		setDiagLoading(true);
		try {
			const d = await client.diagnoseOnePassword();
			setDiag(d);
			setDiagOpen(true);
		} finally {
			setDiagLoading(false);
		}
	}

	async function signOut() {
		if (backend.id !== "1password" && backend.id !== "bitwarden") return;
		if (!confirm(`Sign out of ${backend.label}? Stored session will be cleared.`)) return;
		await client.signOutBackend(backend.id);
		await onChange();
	}

	const spec = install?.specs.find((s) => s.id === backend.id);
	const signedIn = backend.signedIn === true;
	const installed = backend.available;

	return (
		<div>
			<button type="button" className="back-btn" onClick={onBack}>
				← Backends
			</button>
			<div className="detail-panel">
				<div className="detail-header">
					<h3>{backend.label}</h3>
					<span
						className={`badge ${!installed ? "err" : !signedIn ? "warn" : "ok"}`}
					>
						{!installed ? "Not installed" : !signedIn ? "Signed out" : "Ready"}
					</span>
					{backend.authMode === "desktop-app" && (
						<span className="badge info">via desktop app</span>
					)}
				</div>

				{backend.detail && <div className="banner">{backend.detail}</div>}

				<InstallInstructions installed={installed} spec={spec} onChange={onChange} />
				{backend.id === "1password" && installed && (
					<OnePasswordDiagnostics
						diag={diag}
						diagLoading={diagLoading}
						diagOpen={diagOpen}
						onRun={runDiagnose}
						onToggle={() => setDiagOpen((x) => !x)}
					/>
				)}

				{/* Sign-in form */}
				{installed && !signedIn && (
					<SigninForm backend={backend} client={client} onDone={onChange} />
				)}

				{/* Sign-out */}
				{installed && signedIn && backend.id !== "in-house" && (
					<BackendSignOut label={backend.label} onSignOut={signOut} />
				)}
			</div>
		</div>
	);
}

function InstallInstructions({
	installed,
	spec,
	onChange,
}: {
	installed: boolean;
	spec: InstallSpec | undefined;
	onChange: () => Promise<void>;
}) {
	const commands = spec?.commands.filter((c): c is { command: string; args: string[] } => c != null) ?? [];
	if (installed || commands.length === 0) return null;
	return (
		<div style={{ marginBottom: 16 }}>
			<h4 style={{ fontSize: 13, margin: "0 0 8px" }}>Install</h4>
			{commands.map((c, idx) => (
				<pre className="diag-block" key={idx}>
					{c.command} {c.args.join(" ")}
				</pre>
			))}
			<p className="hint" style={{ marginTop: 8 }}>
				Run the command above in your terminal, then return here and refresh.
			</p>
			<button type="button" className="btn secondary small" onClick={onChange}>
				Re-detect
			</button>
		</div>
	);
}

function OnePasswordDiagnostics({
	diag,
	diagLoading,
	diagOpen,
	onRun,
	onToggle,
}: {
	diag: OpDiagnostic | null;
	diagLoading: boolean;
	diagOpen: boolean;
	onRun: () => Promise<void>;
	onToggle: () => void;
}) {
	return (
		<div style={{ marginBottom: 16 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
				<h4 style={{ fontSize: 13, margin: 0 }}>Diagnostics</h4>
				<button type="button" className="btn secondary small" onClick={onRun} disabled={diagLoading}>
					{diagLoading ? "Probing…" : "Run diagnostics"}
				</button>
				{diag && (
					<button type="button" className="btn ghost small" onClick={onToggle}>
						{diagOpen ? "Hide raw" : "Show raw"}
					</button>
				)}
			</div>
			{diag && <div className="banner" style={{ marginBottom: 8 }}>{diag.hint}</div>}
			{diag && diagOpen && <OnePasswordDiagnosticRows diag={diag} />}
		</div>
	);
}

function OnePasswordDiagnosticRows({ diag }: { diag: OpDiagnostic }) {
	return (
		<>
			<DiagRow label="op path" value={diag.opPath ?? "(not found)"} />
			<DiagRow label="op version" value={diag.opVersion ?? "(unknown)"} />
			<DiagRow
				label="account list"
				value={`exit ${diag.accountList.exitCode}\n${diag.accountList.stdout || diag.accountList.stderr || "(empty)"}`}
			/>
			{diag.vaultList && (
				<DiagRow
					label={`vault list (${diag.vaultList.account ?? "?"})`}
					value={`exit ${diag.vaultList.exitCode}\n${diag.vaultList.stdout || diag.vaultList.stderr || "(empty)"}`}
				/>
			)}
			<DiagRow label="auth path" value={diagnosticAuthPath(diag)} />
		</>
	);
}

function diagnosticAuthPath(diag: OpDiagnostic): string {
	if (diag.desktopIntegrationDetected) return "desktop-app integration";
	return diag.sessionTokenStored ? "stored session token" : "(none — sign in below)";
}

function BackendSignOut({ label, onSignOut }: { label: string; onSignOut: () => Promise<void> }) {
	return (
		<div>
			<h4 style={{ fontSize: 13, margin: "16px 0 8px" }}>Sign out</h4>
			<p className="hint">
				Clears the stored session token. Your saved logins remain in the vendor app —
				only this app's access is revoked.
			</p>
			<button type="button" className="btn danger small" onClick={onSignOut}>
				Sign out of {label}
			</button>
		</div>
	);
}

function DiagRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="field-group">
			<label>{label}</label>
			<pre className="diag-block">{value}</pre>
		</div>
	);
}

function SigninForm({
	backend,
	client,
	onDone,
}: {
	backend: BackendStatus;
	client: WebClient;
	onDone: () => Promise<void>;
}) {
	const [email, setEmail] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [signInAddress, setSignInAddress] = useState("");
	const [masterPassword, setMasterPassword] = useState("");
	const [bwClientId, setBwClientId] = useState("");
	const [bwClientSecret, setBwClientSecret] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (backend.id !== "1password" && backend.id !== "bitwarden") {
		return (
			<div className="banner warn">
				Automated sign-in for {backend.label} isn't supported (vendor CLI unstable).
			</div>
		);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			if (backend.id === "1password") {
				await client.signInBackend("1password", {
					email,
					secretKey,
					signInAddress: signInAddress.trim() || undefined,
					masterPassword,
				});
			} else if (backend.id === "bitwarden") {
				await client.signInBackend("bitwarden", {
					bitwardenClientId: bwClientId,
					bitwardenClientSecret: bwClientSecret,
					masterPassword,
				});
			}
			setMasterPassword("");
			await onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form onSubmit={submit}>
			<h4 style={{ fontSize: 13, margin: "16px 0 8px" }}>Sign in</h4>

			{backend.id === "1password" && (
				<>
					<div className="field-group">
						<label>Email</label>
						<input
							type="email"
							autoComplete="username"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</div>
					<div className="field-group">
						<label>Secret Key (34 chars)</label>
						<input
							type="text"
							required
							value={secretKey}
							onChange={(e) => setSecretKey(e.target.value)}
							placeholder="A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
						/>
					</div>
					<div className="field-group">
						<label>Sign-in address (optional, default: my.1password.com)</label>
						<input
							type="text"
							value={signInAddress}
							onChange={(e) => setSignInAddress(e.target.value)}
							placeholder="my.1password.com"
						/>
					</div>
				</>
			)}

			{backend.id === "bitwarden" && (
				<>
					<p className="hint">
						Bitwarden requires API key credentials for non-interactive sign-in.
						Create one at <strong>Settings → Security → Keys → API key</strong>.
					</p>
					<div className="field-group">
						<label>client_id (BW_CLIENTID)</label>
						<input
							type="text"
							required
							value={bwClientId}
							onChange={(e) => setBwClientId(e.target.value)}
						/>
					</div>
					<div className="field-group">
						<label>client_secret (BW_CLIENTSECRET)</label>
						<input
							type="password"
							required
							value={bwClientSecret}
							onChange={(e) => setBwClientSecret(e.target.value)}
						/>
					</div>
				</>
			)}

			<div className="field-group">
				<label>Master password</label>
				<input
					type="password"
					autoComplete="current-password"
					required
					value={masterPassword}
					onChange={(e) => setMasterPassword(e.target.value)}
				/>
			</div>

			{error && <div className="banner error">{error}</div>}

			<button type="submit" className="btn" disabled={submitting}>
				{submitting ? "Signing in…" : `Sign in to ${backend.label}`}
			</button>
		</form>
	);
}
