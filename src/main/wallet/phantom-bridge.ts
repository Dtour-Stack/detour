import type { VersionedTransaction } from "@solana/web3.js";

export type PhantomBridgeApi = {
	getWalletStatus: () => Promise<{
		connected: boolean;
		solanaAddress: string | null;
		ethereumAddress: string | null;
	}>;
	solanaSignAndSend: (tx: VersionedTransaction) => Promise<{ signature: string }>;
	evmSendTransaction: (params: {
		to: `0x${string}`;
		value?: string;
		data?: `0x${string}`;
		gas?: string;
		chainId?: string;
	}) => Promise<{ hash: string }>;
};

let bridge: PhantomBridgeApi | null = null;

/** First mounted Detour view owns the Bun→Phantom bridge; avoids races when multiple windows are open. */
let primaryView: string | null = null;

export function claimPhantomPrimaryHost(view: string): boolean {
	if (primaryView === null || primaryView === view) {
		primaryView = view;
		return true;
	}
	return false;
}

export function releasePhantomPrimaryHost(view: string): void {
	if (primaryView === view) primaryView = null;
}

export function setPhantomBridge(next: PhantomBridgeApi | null): void {
	bridge = next;
}

export function getPhantomBridge(): PhantomBridgeApi {
	if (!bridge) {
		throw new Error(
			"Phantom bridge not ready — ensure DetourPhantomRoot is mounted and PhantomProvider has finished loading.",
		);
	}
	return bridge;
}
