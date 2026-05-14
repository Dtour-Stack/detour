import { type ReactElement, useCallback, useEffect, useState } from "react";
import type { PromptSlotInfo } from "../../../shared/rpc/prompt-slots";
import { rpc } from "../../rpc";

/**
 * Lists every known prompt slot Detour or eliza reads. Slots with no
 * pensieve override show "Using default" and an "Override" button that
 * seeds a pensieve template the user can edit. Slots with an override
 * show "Active override" and a "Open template" button that drills into
 * the existing TemplateEditor by setting the selected id.
 *
 * The panel is read-only on its own; mutation goes through the standard
 * templates API which the parent pane already reloads on save.
 */

export function PromptSlotsPanel({
	onSelectTemplate,
	onReload,
}: {
	onSelectTemplate: (templateId: string) => void;
	onReload: () => void;
}): ReactElement {
	const [slots, setSlots] = useState<PromptSlotInfo[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<"all" | "detour-owned" | "eliza-builtin">("all");

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const result = await rpc.request.promptSlotsList({});
			setSlots(result.slots);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => { void refresh(); }, [refresh]);

	const seed = async (slot: PromptSlotInfo): Promise<void> => {
		setBusy(slot.name);
		try {
			const result = await rpc.request.promptSlotsCreateOverride({ name: slot.name });
			if (result.templateId) {
				await refresh();
				onReload();
				onSelectTemplate(result.templateId);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const filtered = slots.filter((s) => filter === "all" || s.kind === filter);

	return (
		<div className="prompt-slots-panel">
			<div className="prompt-slots-header">
				<div className="prompt-slots-title">Known prompt slots</div>
				<div className="prompt-slots-filter">
					{(["all", "detour-owned", "eliza-builtin"] as const).map((k) => (
						<button
							key={k}
							type="button"
							className={filter === k ? "prompt-slots-filter-btn active" : "prompt-slots-filter-btn"}
							onClick={() => setFilter(k)}
						>
							{k === "all" ? "All" : k === "detour-owned" ? "Detour" : "Eliza"}
						</button>
					))}
				</div>
			</div>
			{error && <div className="banner error">{error}</div>}
			<div className="prompt-slots-list">
				{filtered.map((slot) => (
					<div key={slot.name} className="prompt-slot-card">
						<div className="prompt-slot-head">
							<span className="prompt-slot-label">{slot.label}</span>
							<span className={`badge ${slot.kind === "detour-owned" ? "info" : "muted"}`}>
								{slot.kind === "detour-owned" ? "Detour" : "Eliza"}
							</span>
							{slot.overrideTemplateId ? (
								<span className="badge ok">Overridden</span>
							) : (
								<span className="badge muted">Default</span>
							)}
						</div>
						<div className="prompt-slot-name">
							<code>{slot.name}</code>
						</div>
						<div className="prompt-slot-desc">{slot.description}</div>
						{slot.variables.length > 0 && (
							<div className="prompt-slot-vars">
								Variables:{" "}
								{slot.variables.map((v, i) => (
									<span key={v}>
										<code>{`{{${v}}}`}</code>
										{i < slot.variables.length - 1 ? ", " : ""}
									</span>
								))}
							</div>
						)}
						<div className="prompt-slot-actions">
							{slot.overrideTemplateId ? (
								<button
									type="button"
									className="btn small"
									onClick={() => onSelectTemplate(slot.overrideTemplateId!)}
								>
									Open template
								</button>
							) : (
								<button
									type="button"
									className="btn small primary"
									onClick={() => void seed(slot)}
									disabled={busy === slot.name}
								>
									{busy === slot.name ? "Creating…" : "Override"}
								</button>
							)}
							<span className="prompt-slot-used-in" title={slot.usedIn}>
								read by <code>{slot.usedIn.split(" ")[0]}</code>
							</span>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
