import { useState } from "react";
import type { WebClient } from "../../api/client";
import { ProvidersTab } from "./ProvidersTab";
import { InventoryTab } from "./InventoryTab";
import { SavedLoginsTab } from "./SavedLoginsTab";
import { BackendsTab } from "./BackendsTab";
import { AppearanceTab } from "./AppearanceTab";
import { AgentPermissionsTab } from "./AgentPermissionsTab";
import { AgentCharacterTab } from "./AgentCharacterTab";
import { ModelsTab } from "./ModelsTab";
import { WindowTab } from "./WindowTab";
import { OsPermissionsTab } from "./OsPermissionsTab";
import { LocalAITab } from "./LocalAITab";

type Section = "configuration" | "vault";

type ConfigTab = "appearance" | "providers" | "models" | "local-ai" | "character" | "agent" | "os" | "window";
type VaultTab = "inventory" | "saved-logins" | "backends";

const CONFIG_TABS: { id: ConfigTab; label: string }[] = [
	{ id: "appearance", label: "Appearance" },
	{ id: "providers", label: "Providers" },
	{ id: "models", label: "Models & Routing" },
	{ id: "local-ai", label: "Local AI" },
	{ id: "character", label: "Agent Character" },
	{ id: "agent", label: "Agent Permissions" },
	{ id: "os", label: "OS Permissions" },
	{ id: "window", label: "Window" },
];

const VAULT_TABS: { id: VaultTab; label: string }[] = [
	{ id: "inventory", label: "Inventory" },
	{ id: "saved-logins", label: "Saved Logins" },
	{ id: "backends", label: "Backends" },
];

function ConfigContent({ client, tab }: { client: WebClient; tab: ConfigTab }) {
	switch (tab) {
		case "appearance":
			return <AppearanceTab client={client} />;
		case "providers":
			return <ProvidersTab client={client} />;
		case "models":
			return <ModelsTab client={client} />;
		case "local-ai":
			return <LocalAITab client={client} />;
		case "character":
			return <AgentCharacterTab client={client} />;
		case "agent":
			return <AgentPermissionsTab client={client} />;
		case "os":
			return <OsPermissionsTab client={client} />;
		case "window":
			return <WindowTab client={client} />;
		default:
			return <div className="empty">Unknown configuration tab.</div>;
	}
}

function VaultContent({ client, tab }: { client: WebClient; tab: VaultTab }) {
	switch (tab) {
		case "inventory":
			return <InventoryTab client={client} />;
		case "saved-logins":
			return <SavedLoginsTab client={client} />;
		case "backends":
			return <BackendsTab client={client} />;
		default:
			return <div className="empty">Unknown vault tab.</div>;
	}
}

function SidebarSection<T extends string>({
	active,
	current,
	label,
	onSelect,
	onTab,
	tabs,
}: {
	active: boolean;
	current: T;
	label: string;
	onSelect: () => void;
	onTab: (tab: T) => void;
	tabs: { id: T; label: string }[];
}) {
	return (
		<div className="sidebar-section">
			<button type="button" className={active ? "section-btn active" : "section-btn"} onClick={onSelect}>
				{label}
			</button>
			{active && (
				<div className="sub-nav">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							className={current === t.id ? "sub-nav-btn active" : "sub-nav-btn"}
							onClick={() => onTab(t.id)}
						>
							{t.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export function SettingsView({ client }: { client: WebClient }) {
	const [section, setSection] = useState<Section>("configuration");
	const [configTab, setConfigTab] = useState<ConfigTab>("appearance");
	const [vaultTab, setVaultTab] = useState<VaultTab>("inventory");

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<SidebarSection
					active={section === "configuration"}
					current={configTab}
					label="Configuration"
					onSelect={() => setSection("configuration")}
					onTab={setConfigTab}
					tabs={CONFIG_TABS}
				/>
				<SidebarSection
					active={section === "vault"}
					current={vaultTab}
					label="Vault Nav"
					onSelect={() => setSection("vault")}
					onTab={setVaultTab}
					tabs={VAULT_TABS}
				/>
			</aside>

			<main className="settings-main">
				{section === "configuration" ? <ConfigContent client={client} tab={configTab} /> : <VaultContent client={client} tab={vaultTab} />}
			</main>
		</div>
	);
}
