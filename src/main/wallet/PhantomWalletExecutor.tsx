import { useEffect, useMemo } from "react";
import { AddressType, useEthereum, usePhantom, useSolana } from "@phantom/react-sdk";
import type { VersionedTransaction } from "@solana/web3.js";
import {
	claimPhantomPrimaryHost,
	releasePhantomPrimaryHost,
	setPhantomBridge,
} from "./phantom-bridge";

const viewLabel =
	typeof window !== "undefined"
		? String((window as unknown as { __detourView?: string }).__detourView ?? "chat")
		: "chat";

export function PhantomWalletExecutor() {
	const { isConnected, addresses } = usePhantom();
	const { solana, isAvailable: solanaAvailable } = useSolana();
	const { ethereum, isAvailable: ethAvailable } = useEthereum();

	const api = useMemo(
		() => ({
			getWalletStatus: async () => {
				let solanaAddress: string | null = null;
				let ethereumAddress: string | null = null;
				for (const a of addresses ?? []) {
					if (a.addressType === AddressType.solana) solanaAddress = a.address;
					if (a.addressType === AddressType.ethereum) ethereumAddress = a.address;
				}
				return {
					connected: Boolean(isConnected),
					solanaAddress,
					ethereumAddress,
				};
			},
			solanaSignAndSend: async (tx: VersionedTransaction) => {
				if (!solanaAvailable) throw new Error("Solana provider not available in this session");
				const result = await solana.signAndSendTransaction(tx);
				return { signature: result.signature };
			},
			evmSendTransaction: async (params: {
				to: `0x${string}`;
				value?: string;
				data?: `0x${string}`;
				gas?: string;
				chainId?: string;
			}) => {
				if (!ethAvailable) throw new Error("Ethereum provider not available in this session");
				const hash = await ethereum.sendTransaction({
					to: params.to,
					...(params.value !== undefined ? { value: params.value } : {}),
					...(params.data !== undefined ? { data: params.data } : {}),
					...(params.gas !== undefined ? { gas: params.gas } : {}),
					...(params.chainId !== undefined ? { chainId: params.chainId } : {}),
				});
				return { hash };
			},
		}),
		[addresses, ethAvailable, ethereum, isConnected, solana, solanaAvailable],
	);

	useEffect(() => {
		if (!claimPhantomPrimaryHost(viewLabel)) return;
		setPhantomBridge(api);
		return () => {
			releasePhantomPrimaryHost(viewLabel);
			setPhantomBridge(null);
		};
	}, [api, viewLabel]);

	return null;
}
