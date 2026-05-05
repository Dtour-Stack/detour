import { useState } from "react";
import type { WebClient } from "../../api/client";
import { ProvidersTab } from "./ProvidersTab";
import { InventoryTab } from "./InventoryTab";
import { SavedLoginsTab } from "./SavedLoginsTab";
import { BackendsTab } from "./BackendsTab";
import { AppearanceTab } from "./AppearanceTab";
import { AgentPermissionsTab } from "./AgentPermissionsTab";
import { ModelsTab } from "./ModelsTab";
import { WindowTab } from "./WindowTab";
import { OsPermissionsTab } from "./OsPermissionsTab";
import { LocalAITab } from "./LocalAITab";

type Section = "configuration" | "vault";

type ConfigTab = "appearance" | "providers" | "models" | "local-ai" | "agent" | "os" | "window";
type VaultTab = "inventory" | "saved-logins" | "backends";

const CONFIG_TABS: { id: ConfigTab; label: string }[] = [
	{ id: "appearance", label: "Appearance" },
	{ id: "providers", label: "Providers" },
	{ id: "models", label: "Models & Routing" },
	{ id: "local-ai", label: "Local AI" },
	{ id: "agent", label: "Agent Permissions" },
	{ id: "os", label: "OS Permissions" },
	{ id: "window", label: "Window" },
];

const VAULT_TABS: { id: VaultTab; label: string }[] = [
	{ id: "inventory", label: "Inventory" },
	{ id: "saved-logins", label: "Saved Logins" },
	{ id: "backends", label: "Backends" },
];

export function SettingsView({ client }: { client: WebClient }) {
	const [section, setSection] = useState<Section>("configuration");
	const [configTab, setConfigTab] = useState<ConfigTab>("appearance");
	const [vaultTab, setVaultTab] = useState<VaultTab>("inventory");

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<div className="sidebar-section">
					<button
						type="button"
						className={section === "configuration" ? "section-btn active" : "section-btn"}
						onClick={() => setSection("configuration")}
					>
						Configuration
					</button>
					{section === "configuration" && (
						<div className="sub-nav">
							{CONFIG_TABS.map((t) => (
								<button
									key={t.id}
									type="button"
									className={configTab === t.id ? "sub-nav-btn active" : "sub-nav-btn"}
									onClick={() => setConfigTab(t.id)}
								>
									{t.label}
								</button>
							))}
						</div>
					)}
				</div>

				<div className="sidebar-section">
					<button
						type="button"
						className={section === "vault" ? "section-btn active" : "section-btn"}
						onClick={() => setSection("vault")}
					>
						Vault Nav
					</button>
					{section === "vault" && (
						<div className="sub-nav">
							{VAULT_TABS.map((t) => (
								<button
									key={t.id}
									type="button"
									className={vaultTab === t.id ? "sub-nav-btn active" : "sub-nav-btn"}
									onClick={() => setVaultTab(t.id)}
								>
									{t.label}
								</button>
							))}
						</div>
					)}
				</div>
			</aside>

			<main className="settings-main">
				{section === "configuration" && (
					<>
						{configTab === "appearance" && <AppearanceTab client={client} />}
						{configTab === "providers" && <ProvidersTab client={client} />}
						{configTab === "models" && <ModelsTab client={client} />}
						{configTab === "local-ai" && <LocalAITab client={client} />}
						{configTab === "agent" && <AgentPermissionsTab client={client} />}
						{configTab === "os" && <OsPermissionsTab client={client} />}
						{configTab === "window" && <WindowTab client={client} />}
					</>
				)}
				{section === "vault" && (
					<>
						{vaultTab === "inventory" && <InventoryTab client={client} />}
						{vaultTab === "saved-logins" && <SavedLoginsTab client={client} />}
						{vaultTab === "backends" && <BackendsTab client={client} />}
					</>
				)}
			</main>
		</div>
	);
}
