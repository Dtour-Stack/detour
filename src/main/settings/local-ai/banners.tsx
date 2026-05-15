/**
 * Small inline banners shared across Local AI cards.
 *   - ArbiterRefusalBanner: shown when the memory arbiter refused a start.
 *   - DownloadProgress: rendered while a llama-server is fetching a model.
 */

import type { LlamaServerStatus } from "../../../shared/index";
import { fmtBytes } from "./helpers";

export function ArbiterRefusalBanner({ reason }: { reason: string }) {
	return (
		<div
			className="banner warn"
			style={{
				marginBottom: 10,
				padding: 8,
				fontSize: 12,
				borderRadius: 4,
				background: "rgba(255,159,10,0.12)",
				color: "#ff9f0a",
				border: "1px solid rgba(255,159,10,0.3)",
				lineHeight: 1.4,
			}}
		>
			<strong style={{ display: "block", marginBottom: 2 }}>RAM budget</strong>
			{reason}
		</div>
	);
}

export function DownloadProgress({
	dl,
}: {
	dl: NonNullable<LlamaServerStatus["downloadProgress"]>;
}) {
	return (
		<div style={{ marginBottom: 10 }}>
			<div style={{ fontSize: 12, marginBottom: 4 }}>
				Downloading model — {dl.percent}% ({fmtBytes(dl.downloadedBytes)}/
				{fmtBytes(dl.totalBytes)})
			</div>
			<div
				style={{
					height: 4,
					background: "rgba(128,128,128,0.2)",
					borderRadius: 2,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						width: `${dl.percent}%`,
						height: "100%",
						background: "var(--accent, #0a84ff)",
					}}
				/>
			</div>
		</div>
	);
}
