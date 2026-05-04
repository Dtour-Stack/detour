import Electrobun, { Electroview } from "electrobun/view";
import type { ProviderId, ProviderInfo, SettingsRPC } from "../bun/rpc-schema";
import type { BackendStatus } from "@elizaos/vault";

const rpc = Electroview.defineRPC<SettingsRPC>({
	maxRequestTime: 30_000,
	handlers: { requests: {}, messages: {} },
});

new Electrobun.Electroview({ rpc });

const root = document.getElementById("root") as HTMLDivElement;
const r = (rpc as any).request as {
	listProviders: () => Promise<ProviderInfo[]>;
	setProviderKey: (p: { id: ProviderId; key: string }) => Promise<{ ok: true }>;
	removeProviderKey: (p: { id: ProviderId }) => Promise<{ ok: true }>;
	setActiveProvider: (p: { id: ProviderId }) => Promise<{ ok: true }>;
	detectBackends: () => Promise<BackendStatus[]>;
	getEnabledBackends: () => Promise<string[]>;
	setEnabledBackends: (p: { enabled: string[] }) => Promise<{ ok: true }>;
	closeSettings: () => Promise<{ ok: true }>;
};

async function refresh() {
	const [providers, backends, enabled] = await Promise.all([
		r.listProviders(),
		r.detectBackends().catch(() => [] as BackendStatus[]),
		r.getEnabledBackends().catch(() => [] as string[]),
	]);
	render(providers, backends, enabled);
}

function badgeFor(p: ProviderInfo): string {
	if (p.active) return `<span class="badge ok">Active</span>`;
	if (p.hasKey) return `<span class="badge muted">Configured</span>`;
	return "";
}

function backendBadge(b: BackendStatus, isEnabled: boolean): string {
	if (!b.available) return `<span class="badge err">Not installed</span>`;
	if (b.signedIn === false) return `<span class="badge warn">Signed out</span>`;
	if (isEnabled) return `<span class="badge ok">Enabled</span>`;
	return `<span class="badge muted">Available</span>`;
}

function render(
	providers: ProviderInfo[],
	backends: BackendStatus[],
	enabled: string[],
) {
	const enabledSet = new Set(enabled);
	const providerHtml = providers
		.map((p) => {
			const keyAction = p.hasKey
				? `<button class="btn secondary" data-action="remove" data-id="${p.id}">Remove</button>`
				: `<button class="btn" data-action="save" data-id="${p.id}">Save</button>`;
			const activate = p.hasKey && !p.active
				? `<button class="btn secondary" data-action="activate" data-id="${p.id}">Use this</button>`
				: "";
			return `
				<div class="provider">
					<div class="provider-header">
						<span class="name">${p.label}</span>
						${badgeFor(p)}
					</div>
					<div class="row">
						<input type="password" placeholder="${p.hasKey ? "•••••••• stored" : "API key"}" data-id="${p.id}" />
						${keyAction}
						${activate}
					</div>
				</div>
			`;
		})
		.join("");

	const backendHtml = backends
		.map((b) => {
			const isEnabled = enabledSet.has(b.id);
			const auth = b.authMode ? ` · auth: ${b.authMode}` : "";
			const detail = b.detail ? `<div class="backend-detail">${b.detail}${auth}</div>` : auth ? `<div class="backend-detail">${auth.slice(3)}</div>` : "";
			const toggle = b.id === "in-house"
				? `<span class="badge ok">Always on</span>`
				: `<label class="toggle"><input type="checkbox" data-backend="${b.id}" ${isEnabled ? "checked" : ""} ${!b.available ? "disabled" : ""} /> Use for sensitive keys</label>`;
			return `
				<div class="backend">
					<div class="backend-header">
						<span class="name">${b.label}</span>
						${backendBadge(b, isEnabled)}
					</div>
					${toggle}
					${detail}
				</div>
			`;
		})
		.join("");

	root.innerHTML = `
		<h1>Eliza Settings</h1>
		<p class="subtitle">Keys are stored in your OS keychain via @elizaos/vault. Add at least one provider to chat.</p>

		<section>
			<h2>LLM providers</h2>
			<p class="section-hint">Paste an API key per provider you want to use. The active one handles new messages.</p>
			${providerHtml}
		</section>

		<section>
			<h2>Storage backends</h2>
			<p class="section-hint">By default, sensitive values are encrypted in the local vault (master key in your OS keychain). Enable a password manager to store keys there instead — its CLI must be installed and signed in.</p>
			${backends.length === 0 ? `<div class="empty">Backend detection unavailable.</div>` : backendHtml}
		</section>

		<section>
			<h2>Biometric unlock</h2>
			<p class="section-hint">Touch ID gating for the in-house vault is not yet wired up. Coming next — see project notes.</p>
		</section>
	`;

	root.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const id = btn.dataset.id as ProviderId;
			const action = btn.dataset.action;
			if (action === "save") {
				const input = root.querySelector<HTMLInputElement>(`input[data-id="${id}"]`);
				const key = input?.value.trim() ?? "";
				if (!key) return;
				btn.disabled = true;
				try {
					await r.setProviderKey({ id, key });
					await refresh();
				} finally {
					btn.disabled = false;
				}
			} else if (action === "remove") {
				if (!confirm(`Remove ${id} key?`)) return;
				await r.removeProviderKey({ id });
				await refresh();
			} else if (action === "activate") {
				await r.setActiveProvider({ id });
				await refresh();
			}
		});
	});

	root.querySelectorAll<HTMLInputElement>('input[data-backend]').forEach((cb) => {
		cb.addEventListener("change", async () => {
			const next = Array.from(
				root.querySelectorAll<HTMLInputElement>('input[data-backend]:checked'),
			).map((el) => el.dataset.backend as string);
			// in-house is implicit; manager always allows non-sensitive there
			await r.setEnabledBackends({ enabled: ["in-house", ...next] });
			await refresh();
		});
	});
}

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") void r.closeSettings();
});

void refresh();
