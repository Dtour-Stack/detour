import { useState } from "react";
import type { WebClient } from "../../api/client";
import { ProvidersTab } from "./ProvidersTab";
import { AccountsTab } from "./AccountsTab";
import { InventoryTab } from "./InventoryTab";
import { SavedLoginsTab } from "./SavedLoginsTab";
import { BackendsTab } from "./BackendsTab";

type Tab = "providers" | "accounts" | "inventory" | "saved-logins" | "backends";

const TABS: { id: Tab; label: string }[] = [
	{ id: "providers", label: "Providers" },
	{ id: "accounts", label: "Accounts" },
	{ id: "backends", label: "Backends" },
	{ id: "saved-logins", label: "Saved Logins" },
	{ id: "inventory", label: "Vault" },
];

export function SettingsView({ client }: { client: WebClient }) {
	const [tab, setTab] = useState<Tab>("providers");

	return (
		<div className="settings-page">
			<h2>Settings</h2>
			<p className="subtitle">
				Vault, providers, password manager backends, and saved logins. All keys
				encrypted in your OS keychain via @elizaos/vault.
			</p>

			<div className="tabs">
				{TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						className={tab === t.id ? "tab-btn active" : "tab-btn"}
						onClick={() => setTab(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>

			{tab === "providers" && <ProvidersTab client={client} />}
			{tab === "accounts" && <AccountsTab client={client} />}
			{tab === "backends" && <BackendsTab client={client} />}
			{tab === "saved-logins" && <SavedLoginsTab client={client} />}
			{tab === "inventory" && <InventoryTab client={client} />}
		</div>
	);
}
