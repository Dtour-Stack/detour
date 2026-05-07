import { useEffect, useMemo, useState } from "react";
import type { CodexPetSummary } from "@detour/shared";
import { WebClient } from "../../api/client";

export function PetWindow() {
	const client = useMemo(() => new WebClient(), []);
	const [pet, setPet] = useState<CodexPetSummary | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		document.documentElement.setAttribute("data-surface", "pet");
		return () => document.documentElement.removeAttribute("data-surface");
	}, []);

	useEffect(() => {
		let cancelled = false;
		client
			.connect()
			.then(async () => {
				const active = await client.activePet();
				if (!cancelled) setPet(active.pet);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		const off = client.on((msg) => {
			if (msg.kind === "ui:open-pet" && msg.pet) setPet(msg.pet);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, [client]);

	if (error) return <div className="pet-window pet-window-message">{error}</div>;
	if (!pet) return <div className="pet-window pet-window-message">Hatching...</div>;

	return (
		<div className="pet-window" title={pet.displayName}>
			<div
				className="pet-sprite"
				style={{
					backgroundImage: `url(${pet.spritesheetUrl})`,
					backgroundSize: `${pet.atlas.width}px ${pet.atlas.height}px`,
				}}
			/>
			<div className="pet-name">{pet.displayName}</div>
		</div>
	);
}
