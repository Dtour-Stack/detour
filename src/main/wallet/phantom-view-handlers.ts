import { VersionedTransaction } from "@solana/web3.js";
import { getPhantomBridge } from "./phantom-bridge";

const detourViewLabel =
	typeof window !== "undefined"
		? String((window as unknown as { __detourView?: string }).__detourView ?? "chat")
		: "chat";

export const phantomViewRequestHandlers = {
	phantomViewPing: async (): Promise<{ ok: true; view: string }> => ({
		ok: true,
		view: detourViewLabel,
	}),

	phantomViewGetWalletStatus: async () => getPhantomBridge().getWalletStatus(),

	phantomViewSolanaSignAndSend: async (params: { serializedTransactionBase64: string }) => {
		const raw = Uint8Array.from(atob(params.serializedTransactionBase64), (c) => c.charCodeAt(0));
		const tx = VersionedTransaction.deserialize(raw);
		return getPhantomBridge().solanaSignAndSend(tx);
	},

	phantomViewEvmSendTransaction: async (params: {
		to: `0x${string}`;
		value?: string;
		data?: `0x${string}`;
		gas?: string;
		chainId?: string;
	}) => getPhantomBridge().evmSendTransaction(params),
};
