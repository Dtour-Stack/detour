import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PensieveView } from "./features/pensieve/PensieveView";
import { ActivityView } from "./features/activity/ActivityView";
import { AgentsView } from "./features/activity/AgentsPane";
import { ChannelsView } from "./features/channels/ChannelsView";
import { BrowserView } from "./features/browser/BrowserView";
import "./index.css";

// Hash-routing: the same Vite bundle serves four windows.
//   #pensieve → memory + relationship browser (own window)
//   #activity → trajectories + logs + runtime introspection (own window)
//   #agents   → coding-agent terminal sessions
//   #channels → connected messaging surfaces (Discord/Telegram/iMessage)
//   #browser  → isolated multi-tab agent browser
//   default   → chat popup (App)
const hash = typeof window !== "undefined" ? window.location.hash.split("?")[0] : "";
const root =
	hash === "#pensieve" ? <PensieveView /> :
	hash === "#activity" ? <ActivityView /> :
	hash === "#agents" ? <AgentsView /> :
	hash === "#channels" ? <ChannelsView /> :
	hash === "#browser" ? <BrowserView /> :
	<App />;

createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
