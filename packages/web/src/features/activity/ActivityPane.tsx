import { useState } from "react";
import type { WebClient } from "../../api/client";
import { TrajectoriesPane } from "./TrajectoriesPane";
import { LogsPane } from "./LogsPane";
import { RuntimePane } from "./RuntimePane";

type Tab = "trajectories" | "logs" | "runtime";

const TABS: { id: Tab; label: string }[] = [
	{ id: "trajectories", label: "Trajectories" },
	{ id: "logs", label: "Logs" },
	{ id: "runtime", label: "Runtime" },
];

export function ActivityPane({ client }: { client: WebClient }) {
	const [tab, setTab] = useState<Tab>("trajectories");
	return (
		<div className="pensieve-pane">
			<div className="pensieve-tabs">
				{TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						className={tab === t.id ? "pensieve-tab active" : "pensieve-tab"}
						onClick={() => setTab(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="pensieve-pane-body">
				{tab === "trajectories" && <TrajectoriesPane client={client} />}
				{tab === "logs" && <LogsPane client={client} />}
				{tab === "runtime" && <RuntimePane client={client} />}
			</div>
		</div>
	);
}
