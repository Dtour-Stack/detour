import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./chat/App";
import { PensieveView } from "./pensieve/PensieveView";
import { ActivityView } from "./activity/ActivityView";
import { BrowserView } from "./browser/BrowserView";
import { PortlessView } from "./portless/PortlessView";
import { WorkspaceView } from "./workspace/WorkspaceView";
import { PetWindow } from "./pet/PetWindow";
import { GalleryView } from "./gallery/GalleryView";
import { TrayPopoverView } from "./tray-popover/TrayPopoverView";
import { DetourPhantomRoot } from "./wallet/DetourPhantomRoot";
import "./index.css";

// Per-window view selection: each window opens a distinct HTML wrapper
// (views://main/<name>.html) that injects window.__detourView before this
// bundle runs. We read it synchronously here. The `hash` fallback exists
// for the DETOUR_DEV_URL path (real HTTP server, fragments work normally).
//   pensieve → memory + relationship browser
//   activity → trajectories + logs + runtime introspection
//   channels → chat hub opened to messaging connections
//   browser  → isolated multi-tab agent browser
//   portless → local-dev reverse proxy management
//   default  → chat popup (App)
const view = typeof window !== "undefined"
	? ((window as unknown as { __detourView?: string }).__detourView ?? window.location.hash.slice(1))
	: "";
const root =
	view === "pensieve" ? <PensieveView /> :
	view === "activity" ? <ActivityView /> :
	view === "channels" ? <App initialView="feed" initialDrawer="channels" /> :
	view === "browser" ? <BrowserView /> :
	view === "portless" ? <PortlessView /> :
	view === "workspace" ? <WorkspaceView /> :
	view === "pet" ? <PetWindow /> :
	view === "gallery" ? <GalleryView /> :
	view === "tray-popover" ? <TrayPopoverView /> :
	<App />;

// The tray popover is a transient menu — it doesn't need the Phantom
// wallet provider tree (which is heavy and unused at this surface). Skip
// the wrapper for that view so the popover is small + cheap.
const wrapped = view === "tray-popover" ? root : <DetourPhantomRoot>{root}</DetourPhantomRoot>;

createRoot(document.getElementById("root")!).render(
	<StrictMode>{wrapped}</StrictMode>,
);
