import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./chat/App";
import { RecapPopup } from "./recap/RecapPopup";
import { PetWindow } from "./pet/PetWindow";
import { TrayPopoverView } from "./tray-popover/TrayPopoverView";
import { StatusWidget } from "./status-widget/StatusWidget";
import { CapsuleView } from "./capsule/CapsuleView";
import { DetourPhantomRoot } from "./wallet/DetourPhantomRoot";
import "./index.css";

// Per-window view selection: each window opens a distinct HTML wrapper
// (views://main/<name>.html) that injects window.__detourView before this
// bundle runs. We read it synchronously here. The `hash` fallback exists
// for the DETOUR_DEV_URL path (real HTTP server, fragments work normally).
//
// Only genuinely separate windows get a branch here. The tool views
// (pensieve / activity / browser / gallery / portless) and settings live as
// tabs/drawers inside the hub (<App/>), reached via uiOpen* broadcasts — they
// no longer have standalone window shells.
//   pet           → floating companion window
//   tray-popover  → menubar quick-actions popover
//   status-widget → floating status pill
//   capsule       → floating capture window
//   default       → Detour hub (App: chat + channel rail + tool tabs + drawers)
const view = typeof window !== "undefined"
	? ((window as unknown as { __detourView?: string }).__detourView ?? window.location.hash.slice(1))
	: "";
const root =
	view === "pet" ? <PetWindow /> :
	view === "tray-popover" ? <TrayPopoverView /> :
	view === "status-widget" ? <StatusWidget /> :
	view === "capsule" ? <CapsuleView /> :
	<><App /><RecapPopup /></>;

// The tray popover + status widget are transient surfaces — they don't
// need the Phantom wallet provider tree (heavy + unused there). Skip
// the wrapper so each window is small + cheap.
const skipPhantomWrap = view === "tray-popover" || view === "status-widget" || view === "capsule";
const wrapped = skipPhantomWrap ? root : <DetourPhantomRoot>{root}</DetourPhantomRoot>;

createRoot(document.getElementById("root")!).render(
	<StrictMode>{wrapped}</StrictMode>,
);
