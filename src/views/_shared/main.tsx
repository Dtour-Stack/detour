import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../chat/App";
import { PensieveView } from "../pensieve/PensieveView";
import { ActivityView } from "../activity/ActivityView";
import { ChannelsView } from "../channels/ChannelsView";
import { BrowserView } from "../browser/BrowserView";
import "./index.css";

// Hash-routing: the same Vite bundle serves four windows.
//   #pensieve → memory + relationship browser (own window)
//   #activity → trajectories + logs + runtime introspection (own window)
//   #channels → connected messaging surfaces (Discord/Telegram/iMessage)
//   #browser  → isolated multi-tab agent browser
//   default   → chat popup (App)
const hash = typeof window !== "undefined" ? window.location.hash : "";
const root =
	hash === "#pensieve" ? <PensieveView /> :
	hash === "#activity" ? <ActivityView /> :
	hash === "#channels" ? <ChannelsView /> :
	hash === "#browser" ? <BrowserView /> :
	<App />;

createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
