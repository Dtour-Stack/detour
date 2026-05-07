import { useEffect, useMemo, useState } from "react";
import { WebClient } from "../../api/client";
import { CommandPalette } from "./CommandPalette";

export function CommandPaletteWindow() {
	const client = useMemo(() => new WebClient(), []);
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		client
			.connect()
			.then(() => setConnected(true))
			.catch(() => setConnected(false));
	}, [client]);

	return (
		<div className="command-palette-window">
			{connected ? (
				<CommandPalette
					client={client}
					open={true}
					windowed={true}
					onClose={() => client.closeCommandPalette()}
					onOpenSettings={() => {
						void client.openWindow("settings");
						client.closeCommandPalette();
					}}
					onChatCommand={(command) => {
						void client.openWindow("chat");
						setTimeout(() => client.runChatCommand(command), 250);
					}}
				/>
			) : (
				<div className="command-palette-connect">Connecting...</div>
			)}
		</div>
	);
}
