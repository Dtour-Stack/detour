import { useEffect, useState } from "react";
import { SidebarIcon, type IconName } from "../SidebarIcon";
import { ProvidersTab } from "./ProvidersTab";
import { AgentMailTab } from "./AgentMailTab";
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
import { CloudAppsTab } from "./CloudAppsTab";
import { CloudContainersTab } from "./CloudContainersTab";
import { PhantomWalletTab } from "./PhantomWalletTab";
import { AudioTab } from "./AudioTab";
import { SkillsTab } from "./SkillsTab";
import { TrayTab } from "./TrayTab";

type Section = "configuration" | "vault" | "cloud";

type ConfigTab = "appearance" | "providers" | "models" | "local-ai" | "audio" | "character" | "agent" | "skills" | "os" | "window" | "phantom" | "tray" | "agentmail";
type VaultTab = "inventory" | "saved-logins" | "backends";
type CloudTab = "elizacloud" | "apps" | "containers";

// Tabs are visually grouped by ordering (no nested headers — the
// sidebar's flat tab list keeps the IA simple): models/providers,
// then agent surfaces, then channel/wallet, then system.
const CONFIG_TABS: { id: ConfigTab; label: string }[] = [
	{ id: "providers", label: "Providers" },
	{ id: "models", label: "Models & Routing" },
	{ id: "local-ai", label: "Local AI" },
	{ id: "audio", label: "Audio" },
	{ id: "agentmail", label: "Email (AgentMail)" },
	{ id: "character", label: "Agent Character" },
	{ id: "agent", label: "Agent Permissions" },
	{ id: "skills", label: "Skills" },
	{ id: "phantom", label: "Phantom wallet" },
	{ id: "appearance", label: "Appearance" },
	{ id: "tray", label: "Tray" },
	{ id: "window", label: "Window" },
	{ id: "os", label: "OS Permissions" },
];

const VAULT_TABS: { id: VaultTab; label: string }[] = [
	{ id: "inventory", label: "Inventory" },
	{ id: "saved-logins", label: "Saved Logins" },
	{ id: "backends", label: "Backends" },
];

const CLOUD_TABS: { id: CloudTab; label: string }[] = [
	{ id: "elizacloud", label: "ElizaOS Cloud" },
	{ id: "apps", label: "Apps" },
	{ id: "containers", label: "Containers" },
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
		case "audio":
			return <AudioTab />;
		case "agentmail":
			return <AgentMailTab />;
		case "character":
			return <AgentCharacterTab />;
		case "agent":
			return <AgentPermissionsTab />;
		case "skills":
			return <SkillsTab />;
		case "phantom":
			return <PhantomWalletTab />;
		case "os":
			return <OsPermissionsTab />;
		case "window":
			return <WindowTab />;
		case "tray":
			return <TrayTab />;
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
		case "apps":
			return <CloudAppsTab />;
		case "containers":
			return <CloudContainersTab />;
		default:
			return <div className="empty">Unknown cloud tab.</div>;
	}
}

function SidebarSection<T extends string>({
	active,
	current,
	label,
	icon,
	onSelect,
	onTab,
	tabs,
}: {
	active: boolean;
	current: T;
	label: string;
	icon: IconName;
	onSelect: () => void;
	onTab: (tab: T) => void;
	tabs: { id: T; label: string }[];
}) {
	return (
		<div className="sidebar-section">
			<button
				type="button"
				className={active ? "section-btn active" : "section-btn"}
				onClick={onSelect}
				title={label}
			>
				<SidebarIcon name={icon} />
				<span className="section-btn-label">{label}</span>
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

type DeepLink = `${Section}:${ConfigTab | VaultTab | CloudTab}`;

const CONFIG_TAB_IDS = new Set<string>(CONFIG_TABS.map((t) => t.id));
const VAULT_TAB_IDS = new Set<string>(VAULT_TABS.map((t) => t.id));
const CLOUD_TAB_IDS = new Set<string>(CLOUD_TABS.map((t) => t.id));

/**
 * Parse a deep-link of the form `section:tab` (e.g. `configuration:local-ai`)
 * and return the {section, tab} pair if it's valid, else null. Lets the
 * command palette and any other deep-linker jump straight to a setting.
 */
function parseDeepLink(link: string | null | undefined): {
	section: Section;
	tab: ConfigTab | VaultTab | CloudTab;
} | null {
	if (!link) return null;
	const [sectionRaw, tabRaw] = link.split(":");
	if (!sectionRaw || !tabRaw) return null;
	if (sectionRaw === "configuration" && CONFIG_TAB_IDS.has(tabRaw)) {
		return { section: "configuration", tab: tabRaw as ConfigTab };
	}
	if (sectionRaw === "vault" && VAULT_TAB_IDS.has(tabRaw)) {
		return { section: "vault", tab: tabRaw as VaultTab };
	}
	if (sectionRaw === "cloud" && CLOUD_TAB_IDS.has(tabRaw)) {
		return { section: "cloud", tab: tabRaw as CloudTab };
	}
	return null;
}

export interface SettingsViewProps {
	/**
	 * Optional deep-link to land on a specific tab. Format:
	 * `"configuration:local-ai"`. Consumed once; caller is notified via
	 * `onConsumeDeepLink` so it can clear its own state.
	 */
	deepLink?: string;
	onConsumeDeepLink?: () => void;
}

export function SettingsView({ deepLink, onConsumeDeepLink }: SettingsViewProps = {}) {
	const [section, setSection] = useState<Section>("configuration");
	const [configTab, setConfigTab] = useState<ConfigTab>("providers");
	const [vaultTab, setVaultTab] = useState<VaultTab>("inventory");
	const [cloudTab, setCloudTab] = useState<CloudTab>("elizacloud");

	// Apply any deep-link prop on mount and on subsequent changes — the
	// parent (chat App) re-sets it on each uiOpenSettings broadcast.
	useEffect(() => {
		const parsed = parseDeepLink(deepLink);
		if (!parsed) return;
		setSection(parsed.section);
		if (parsed.section === "configuration") setConfigTab(parsed.tab as ConfigTab);
		else if (parsed.section === "vault") setVaultTab(parsed.tab as VaultTab);
		else if (parsed.section === "cloud") setCloudTab(parsed.tab as CloudTab);
		onConsumeDeepLink?.();
	}, [deepLink, onConsumeDeepLink]);

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<SidebarSection
					active={section === "configuration"}
					current={configTab}
					label="Configuration"
					icon="gear"
					onSelect={() => setSection("configuration")}
					onTab={setConfigTab}
					tabs={CONFIG_TABS}
				/>
				<SidebarSection
					active={section === "vault"}
					current={vaultTab}
					label="Vault"
					icon="vault"
					onSelect={() => setSection("vault")}
					onTab={setVaultTab}
					tabs={VAULT_TABS}
				/>
				<SidebarSection
					active={section === "cloud"}
					current={cloudTab}
					label="Cloud"
					icon="cloud"
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
