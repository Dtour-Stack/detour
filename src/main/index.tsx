import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./chat/App";
import { PensieveView } from "./pensieve/PensieveView";
import { ActivityView } from "./activity/ActivityView";
import { ChannelsView } from "./channels/ChannelsView";
import { BrowserView } from "./browser/BrowserView";
import { PortlessView } from "./portless/PortlessView";
import { WorkspaceView } from "./workspace/WorkspaceView";
import { PetWindow } from "./pet/PetWindow";
import { DetourPhantomRoot } from "./wallet/DetourPhantomRoot";
import "./index.css";

// Per-window view selection: each window opens a distinct HTML wrapper
// (views://main/<name>.html) that injects window.__detourView before this
// bundle runs. We read it synchronously here. The `hash` fallback exists
// for the DETOUR_DEV_URL path (real HTTP server, fragments work normally).
//   pensieve → memory + relationship browser
//   activity → trajectories + logs + runtime introspection
//   channels → connected messaging surfaces (Discord/Telegram/iMessage)
//   browser  → isolated multi-tab agent browser
//   portless → local-dev reverse proxy management
//   default  → chat popup (App)
const view = typeof window !== "undefined"
	? ((window as unknown as { __detourView?: string }).__detourView ?? window.location.hash.slice(1))
	: "";
const root =
	view === "pensieve" ? <PensieveView /> :
	view === "activity" ? <ActivityView /> :
	view === "channels" ? <ChannelsView /> :
	view === "browser" ? <BrowserView /> :
	view === "portless" ? <PortlessView /> :
	view === "workspace" ? <WorkspaceView /> :
	view === "pet" ? <PetWindow /> :
	<App />;

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<DetourPhantomRoot>{root}</DetourPhantomRoot>
	</StrictMode>,
);
