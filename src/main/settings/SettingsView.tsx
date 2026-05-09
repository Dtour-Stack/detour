import { useState } from "react";
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
import { ElizaCloudTab } from "./ElizaCloudTab";

type Section = "configuration" | "vault" | "cloud";

type ConfigTab = "appearance" | "providers" | "models" | "local-ai" | "character" | "agent" | "os" | "window";
type VaultTab = "inventory" | "saved-logins" | "backends";
type CloudTab = "elizacloud";

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

const CLOUD_TABS: { id: CloudTab; label: string }[] = [
	{ id: "elizacloud", label: "ElizaOS Cloud" },
];

function ConfigContent({ tab }: { tab: ConfigTab }) {
	switch (tab) {
		case "appearance":
			return <AppearanceTab />;
		case "providers":
			return <ProvidersTab />;
		case "models":
			return <ModelsTab />;
		case "local-ai":
			return <LocalAITab />;
		case "character":
			return <AgentCharacterTab />;
		case "agent":
			return <AgentPermissionsTab />;
		case "os":
			return <OsPermissionsTab />;
		case "window":
			return <WindowTab />;
		default:
			return <div className="empty">Unknown configuration tab.</div>;
	}
}

function VaultContent({ tab }: { tab: VaultTab }) {
	switch (tab) {
		case "inventory":
			return <InventoryTab />;
		case "saved-logins":
			return <SavedLoginsTab />;
		case "backends":
			return <BackendsTab />;
		default:
			return <div className="empty">Unknown vault tab.</div>;
	}
}

function CloudContent({ tab }: { tab: CloudTab }) {
	switch (tab) {
		case "elizacloud":
			return <ElizaCloudTab />;
		default:
			return <div className="empty">Unknown cloud tab.</div>;
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

export function SettingsView() {
	const [section, setSection] = useState<Section>("configuration");
	const [configTab, setConfigTab] = useState<ConfigTab>("appearance");
	const [vaultTab, setVaultTab] = useState<VaultTab>("inventory");
	const [cloudTab, setCloudTab] = useState<CloudTab>("elizacloud");

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
				<SidebarSection
					active={section === "cloud"}
					current={cloudTab}
					label="Cloud"
					onSelect={() => setSection("cloud")}
					onTab={setCloudTab}
					tabs={CLOUD_TABS}
				/>
			</aside>

			<main className="settings-main">
				{section === "configuration"
					? <ConfigContent tab={configTab} />
					: section === "vault"
						? <VaultContent tab={vaultTab} />
						: <CloudContent tab={cloudTab} />}
			</main>
		</div>
	);
}
