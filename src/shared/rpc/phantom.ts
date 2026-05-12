/**
 * Phantom Connect — embedded wallet + Solana/EVM signing from the Bun
 * agent via view-side @phantom/react-sdk.
 *
 * Flow: plugin or handler calls bun `phantom*` requests → registry fans
 * into the first live webview's `phantomView*` handlers → Phantom hooks.
 */

/** Bun-side: config + signing entrypoints (agent / tools call these). */
export type PhantomBunRequests = {
	phantomGetPortalConfig: {
		params: Record<string, never>;
		response: {
			appId: string | null;
			redirectUrl: string | null;
			/** Paste into Phantom Portal → Allowed Origins (scheme + host + port, no path). */
			portalAllowedOrigins: string[];
			/** Paste into Phantom Portal → Redirect URLs (exact callback URLs). */
			portalRedirectUrls: string[];
		};
	};
	phantomGetWalletStatus: {
		params: Record<string, never>;
		response: {
			connected: boolean;
			solanaAddress: string | null;
			ethereumAddress: string | null;
		};
	};
	phantomSolanaSignAndSend: {
		params: { serializedTransactionBase64: string };
		response: { signature: string };
	};
	phantomEvmSendTransaction: {
		params: {
			to: `0x${string}`;
			value?: string;
			data?: `0x${string}`;
			gas?: string;
			chainId?: string;
		};
		response: { hash: string };
	};
};

/** Webview-side: Bun invokes these on a window's RPC (Phantom hooks run here). */
export type PhantomWebviewRequests = {
	phantomViewPing: {
		params: Record<string, never>;
		response: { ok: true; view: string };
	};
	phantomViewGetWalletStatus: {
		params: Record<string, never>;
		response: {
			connected: boolean;
			solanaAddress: string | null;
			ethereumAddress: string | null;
		};
	};
	phantomViewSolanaSignAndSend: {
		params: { serializedTransactionBase64: string };
		response: { signature: string };
	};
	phantomViewEvmSendTransaction: {
		params: {
			to: `0x${string}`;
			value?: string;
			data?: `0x${string}`;
			gas?: string;
			chainId?: string;
		};
		response: { hash: string };
	};
};
