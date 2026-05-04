import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PensieveView } from "./features/pensieve/PensieveView";
import { ActivityView } from "./features/activity/ActivityView";
import "./index.css";

// Hash-routing: the same Vite bundle serves three windows.
//   #pensieve → memory + relationship browser (own window)
//   #activity → trajectories + logs + runtime introspection (own window)
//   default   → chat popup (App)
const hash = typeof window !== "undefined" ? window.location.hash : "";
const root =
	hash === "#pensieve" ? <PensieveView /> :
	hash === "#activity" ? <ActivityView /> :
	<App />;

createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
