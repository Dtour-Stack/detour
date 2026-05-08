import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { CodexPetActivity, CodexPetAnimationState, CodexPetSummary, WindowOpenTarget } from "@detour/shared";
import { WebClient } from "../../api/client";

type AnimationSpec = {
	state: CodexPetAnimationState;
	label: string;
	row: number;
	frames: number;
	durationMs: number;
};

const ANIMATIONS: AnimationSpec[] = [
	{ state: "idle", label: "idle", row: 0, frames: 6, durationMs: 2200 },
	{ state: "waiting", label: "watching", row: 6, frames: 6, durationMs: 2600 },
	{ state: "review", label: "reviewing", row: 8, frames: 6, durationMs: 1900 },
	{ state: "waving", label: "checking in", row: 3, frames: 4, durationMs: 1800 },
	{ state: "running", label: "moving", row: 7, frames: 6, durationMs: 1500 },
	{ state: "jumping", label: "shipping", row: 4, frames: 5, durationMs: 1700 },
	{ state: "running-right", label: "sprinting", row: 1, frames: 8, durationMs: 1400 },
	{ state: "running-left", label: "looping back", row: 2, frames: 8, durationMs: 1400 },
];

const FAILED: AnimationSpec = { state: "failed", label: "needs attention", row: 5, frames: 8, durationMs: 2100 };
const IDLE_ANIMATION_STATES: CodexPetAnimationState[] = ["idle", "idle", "idle", "waiting", "idle", "waving"];

type PetMenuItem =
	| { label: string; target: WindowOpenTarget }
	| { label: string; action: "spawn" };

const PET_MENU_ITEMS: PetMenuItem[] = [
	{ label: "Chat", target: "chat" },
	{ label: "Commands", target: "command-palette" },
	{ label: "Settings", target: "settings" },
	{ label: "Activity", target: "activity" },
	{ label: "Agents", target: "agents" },
	{ label: "Pensieve", target: "pensieve" },
	{ label: "Channels", target: "channels" },
	{ label: "Browser", target: "browser" },
	{ label: "Spawn Pet", action: "spawn" },
];

type SpriteStyle = CSSProperties & {
	"--pet-row": number;
	"--pet-frames": number;
	"--pet-duration": string;
};

type PetMenuItemStyle = CSSProperties & {
	"--pet-menu-index": number;
};

type PetDrag = {
	pointerId: number;
	lastX: number;
	lastY: number;
	total: number;
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
	const [menuOpen, setMenuOpen] = useState(false);
	const [idleIndex, setIdleIndex] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const dragRef = useRef<PetDrag | null>(null);

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
		const timer = setInterval(() => {
			setIdleIndex((index) => (index + 1) % IDLE_ANIMATION_STATES.length);
		}, 12_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (!menuOpen) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenuOpen(false);
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [menuOpen]);

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

	const activityState = activity?.state ?? "idle";
	const animationState = manualState ?? (activityState === "idle" ? IDLE_ANIMATION_STATES[idleIndex] ?? "idle" : activityState);
	const animation = animationForState(animationState);
	const style: SpriteStyle = {
		backgroundImage: `url(${pet.spritesheetUrl})`,
		backgroundSize: `${pet.atlas.width}px ${pet.atlas.height}px`,
		"--pet-row": animation.row,
		"--pet-frames": animation.frames,
		"--pet-duration": `${animation.durationMs}ms`,
	};
	const detail = clampText(activity?.detail);
	const openMenuItem = async (item: PetMenuItem) => {
		setMenuOpen(false);
		if ("target" in item) {
			await client.openWindow(item.target);
			return;
		}
		const spawned = await client.spawnPet();
		setPet(spawned.pet);
		setManualState(spawned.state);
	};
	const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			lastX: event.screenX,
			lastY: event.screenY,
			total: 0,
		};
		setDragging(true);
	};
	const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const dx = event.screenX - drag.lastX;
		const dy = event.screenY - drag.lastY;
		if (dx === 0 && dy === 0) return;
		drag.lastX = event.screenX;
		drag.lastY = event.screenY;
		drag.total += Math.hypot(dx, dy);
		if (drag.total > 4 && menuOpen) setMenuOpen(false);
		client.movePetWindow(dx, dy);
	};
	const stopDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		if (drag.total <= 4) setMenuOpen((open) => !open);
	};

	return (
		<div
			className={`pet-window${dragging ? " dragging" : ""}`}
			title={`${pet.displayName} - drag to move`}
		>
			<div className="pet-activity">
				<div className={`pet-activity-dot ${activity?.state ?? animation.state}`} />
				<div className="pet-activity-copy">
					<strong>{activity?.summary ?? animation.label}</strong>
					{detail && <span>{detail}</span>}
				</div>
			</div>
			<div className="pet-stage">
				<button
					type="button"
					className="pet-character-button"
					onPointerDown={startDrag}
					onPointerMove={moveDrag}
					onPointerUp={stopDrag}
					onPointerCancel={stopDrag}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							setMenuOpen((open) => !open);
						}
					}}
					aria-expanded={menuOpen}
					aria-label={`${pet.displayName} menu`}
				>
					<div
						key={animation.state}
						className="pet-sprite"
						style={style}
						aria-label={`${pet.displayName} ${animation.label}`}
					/>
				</button>
				<div className="pet-name">{pet.displayName}</div>
			</div>
			{menuOpen && (
				<div className="pet-goo-menu electrobun-webkit-app-region-no-drag" role="menu">
					{PET_MENU_ITEMS.map((item, index) => (
						<button
							key={item.label}
							type="button"
							className="pet-goo-menu-item"
							style={{ "--pet-menu-index": index } as PetMenuItemStyle}
							onClick={() => void openMenuItem(item)}
							role="menuitem"
						>
							{item.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
