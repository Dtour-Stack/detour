import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PensieveView } from "./features/pensieve/PensieveView";
import { ActivityView } from "./features/activity/ActivityView";
import { AgentsView } from "./features/activity/AgentsPane";
import { ChannelsView } from "./features/channels/ChannelsView";
import { BrowserView } from "./features/browser/BrowserView";
import { CommandPaletteWindow } from "./features/command-palette/CommandPaletteWindow";
import "./index.css";

type ViewRoute = "chat" | "pensieve" | "activity" | "agents" | "channels" | "browser" | "command-palette";

const VIEW_ROUTES = new Set<ViewRoute>([
	"chat",
	"pensieve",
	"activity",
	"agents",
	"channels",
	"browser",
	"command-palette",
]);

function routeFromLocation(): ViewRoute {
	if (typeof window === "undefined") return "chat";
	const searchView = new URLSearchParams(window.location.search).get("view");
	if (searchView && VIEW_ROUTES.has(searchView as ViewRoute)) return searchView as ViewRoute;
	const hashView = window.location.hash.split("?")[0]?.replace(/^#/, "");
	if (hashView && VIEW_ROUTES.has(hashView as ViewRoute)) return hashView as ViewRoute;
	const pathView = window.location.pathname.split("/").filter(Boolean).pop();
	if (pathView && VIEW_ROUTES.has(pathView as ViewRoute)) return pathView as ViewRoute;
	return "chat";
}

const route = routeFromLocation();
const root =
	route === "pensieve" ? <PensieveView /> :
	route === "activity" ? <ActivityView /> :
	route === "agents" ? <AgentsView /> :
	route === "channels" ? <ChannelsView /> :
	route === "browser" ? <BrowserView /> :
	route === "command-palette" ? <CommandPaletteWindow /> :
	<App />;

createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
