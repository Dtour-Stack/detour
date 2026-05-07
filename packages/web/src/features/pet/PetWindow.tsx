import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { CodexPetActivity, CodexPetAnimationState, CodexPetSummary } from "@detour/shared";
import { WebClient } from "../../api/client";

type AnimationSpec = {
	state: CodexPetAnimationState;
	label: string;
	row: number;
	frames: number;
	durationMs: number;
};

const ANIMATIONS: AnimationSpec[] = [
	{ state: "idle", label: "idle", row: 0, frames: 6, durationMs: 1200 },
	{ state: "waiting", label: "watching", row: 6, frames: 6, durationMs: 1400 },
	{ state: "review", label: "reviewing", row: 8, frames: 6, durationMs: 1200 },
	{ state: "waving", label: "checking in", row: 3, frames: 4, durationMs: 900 },
	{ state: "running", label: "moving", row: 7, frames: 6, durationMs: 850 },
	{ state: "jumping", label: "shipping", row: 4, frames: 5, durationMs: 900 },
	{ state: "running-right", label: "sprinting", row: 1, frames: 8, durationMs: 800 },
	{ state: "running-left", label: "looping back", row: 2, frames: 8, durationMs: 800 },
];

const FAILED: AnimationSpec = { state: "failed", label: "needs attention", row: 5, frames: 8, durationMs: 1200 };

type SpriteStyle = CSSProperties & {
	"--pet-row": number;
	"--pet-frames": number;
	"--pet-duration": string;
};

function clampText(value: string | undefined, max = 92): string {
	if (!value) return "";
	const single = value.replace(/\s+/g, " ").trim();
	return single.length <= max ? single : `${single.slice(0, max - 1)}...`;
}

function animationForState(state: CodexPetAnimationState): AnimationSpec {
	return [...ANIMATIONS, FAILED].find((animation) => animation.state === state) ?? ANIMATIONS[0];
}

export function PetWindow() {
	const client = useMemo(() => new WebClient(), []);
	const [pet, setPet] = useState<CodexPetSummary | null>(null);
	const [activity, setActivity] = useState<CodexPetActivity | null>(null);
	const [manualState, setManualState] = useState<CodexPetAnimationState | null>(null);
	const [dragging, setDragging] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		document.documentElement.setAttribute("data-surface", "pet");
		return () => document.documentElement.removeAttribute("data-surface");
	}, []);

	useEffect(() => {
		if (!manualState) return;
		const timer = setTimeout(() => setManualState(null), 9000);
		return () => clearTimeout(timer);
	}, [manualState]);

	useEffect(() => {
		let cancelled = false;
		const refreshActivity = () => {
			void client.petActivity().then((next) => {
				if (!cancelled) setActivity(next);
			}).catch(() => {});
		};
		client
			.connect()
			.then(async () => {
				const active = await client.activePet();
				if (!cancelled) {
					setPet(active.pet);
					setManualState(active.state);
				}
				refreshActivity();
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		const activityTimer = setInterval(refreshActivity, 2500);
		const off = client.on((msg) => {
			if (msg.kind === "ui:open-pet" && msg.pet) setPet(msg.pet);
			if (msg.kind === "ui:pet-state") setManualState(msg.state);
		});
		return () => {
			cancelled = true;
			clearInterval(activityTimer);
			off();
		};
	}, [client]);

	if (error) return <div className="pet-window pet-window-message">{error}</div>;
	if (!pet) return <div className="pet-window pet-window-message">Hatching...</div>;

	const animation = animationForState(manualState ?? activity?.state ?? "idle");
	const style: SpriteStyle = {
		backgroundImage: `url(${pet.spritesheetUrl})`,
		backgroundSize: `${pet.atlas.width}px ${pet.atlas.height}px`,
		"--pet-row": animation.row,
		"--pet-frames": animation.frames,
		"--pet-duration": `${animation.durationMs}ms`,
	};
	const detail = clampText(activity?.detail);

	return (
		<div
			className={`pet-window electrobun-webkit-app-region-drag${dragging ? " dragging" : ""}`}
			title={`${pet.displayName} - drag to move`}
			onPointerDown={() => setDragging(true)}
			onPointerUp={() => setDragging(false)}
			onPointerCancel={() => setDragging(false)}
			onPointerLeave={() => setDragging(false)}
		>
			<div className="pet-activity">
				<div className={`pet-activity-dot ${activity?.state ?? animation.state}`} />
				<div className="pet-activity-copy">
					<strong>{activity?.summary ?? animation.label}</strong>
					{detail && <span>{detail}</span>}
				</div>
			</div>
			<div className="pet-stage">
				<div
					key={animation.state}
					className="pet-sprite"
					style={style}
					aria-label={`${pet.displayName} ${animation.label}`}
				/>
				<div className="pet-name">{pet.displayName}</div>
			</div>
		</div>
	);
}
