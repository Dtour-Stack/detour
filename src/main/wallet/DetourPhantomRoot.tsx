import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
	AddressType,
	darkTheme,
	PhantomProvider,
} from "@phantom/react-sdk";
import { rpc } from "../rpc";
import { PhantomWalletExecutor } from "./PhantomWalletExecutor";

type Phase = "loading" | "off" | { appId: string; redirectUrl: string };
type DetourPhantomStatus =
	| { state: "loading"; ready: false }
	| { state: "off"; ready: false }
	| { state: "ready"; ready: true; appId: string; redirectUrl: string };

const DetourPhantomStatusContext = createContext<DetourPhantomStatus>({
	state: "loading",
	ready: false,
});

export function useDetourPhantomStatus(): DetourPhantomStatus {
	return useContext(DetourPhantomStatusContext);
}

/**
 * Phantom Connect — **embedded** providers only.
 *
 * Detour’s UI runs in Electrobun’s **native WKWebView**, not Google Chrome. The
 * Phantom **browser extension does not run here**, so `providers: ["injected"]`
 * cannot work. Embedded (`phantom`, `google`, `apple`) + Portal `appId` and
 * `authOptions.redirectUrl` are the supported path inside the app.
 */
export function DetourPhantomRoot({ children }: { children: ReactNode }) {
	const [phase, setPhase] = useState<Phase>("loading");

	useEffect(() => {
		let cancelled = false;
		rpc.request
			.phantomGetPortalConfig({})
			.then((c) => {
				if (cancelled) return;
				const appId = c.appId?.trim() ?? "";
				if (!appId) {
					setPhase("off");
					return;
				}
				const fromServer = c.redirectUrl?.trim() ?? "";
				const fromLocation =
					typeof location !== "undefined" ? `${location.origin}/` : "";
				const redirectUrl = fromServer || fromLocation;
				if (!redirectUrl) {
					console.warn(
						"[phantom] embedded Connect needs a redirect URL — set PHANTOM_CONNECT_REDIRECT_URL, or portless + DETOUR_DEV_URL / PHANTOM_PORTLESS_FQDN per Bun phantom handler, or open the UI over http(s) so location.origin is valid.",
					);
					setPhase("off");
					return;
				}
				setPhase({ appId, redirectUrl });
			})
			.catch(() => {
				if (!cancelled) setPhase("off");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (phase === "loading") {
		return (
			<DetourPhantomStatusContext.Provider value={{ state: "loading", ready: false }}>
				{children}
			</DetourPhantomStatusContext.Provider>
		);
	}
	if (phase === "off") {
		return (
			<DetourPhantomStatusContext.Provider value={{ state: "off", ready: false }}>
				{children}
			</DetourPhantomStatusContext.Provider>
		);
	}

	return (
		<DetourPhantomStatusContext.Provider
			value={{ state: "ready", ready: true, appId: phase.appId, redirectUrl: phase.redirectUrl }}
		>
			<PhantomProvider
				config={{
					appId: phase.appId,
					providers: ["phantom", "google", "apple"],
					addressTypes: [AddressType.solana, AddressType.ethereum],
					embeddedWalletType: "user-wallet",
					authOptions: {
						redirectUrl: phase.redirectUrl,
					},
				}}
				theme={darkTheme}
				appName="Detour"
			>
				<PhantomWalletExecutor />
				{children}
			</PhantomProvider>
		</DetourPhantomStatusContext.Provider>
	);
}
