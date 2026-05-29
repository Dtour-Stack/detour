import type { CSSProperties } from "react";

/**
 * Reusable loading skeleton. A decorative shimmering placeholder block that
 * sweeps a brand-accent highlight across itself (see `.skeleton` in index.css).
 *
 * Accessibility: each block is `aria-hidden` (it carries no information). Put
 * `aria-busy="true"` on the CONTAINER that is loading, and swap to real content
 * when it arrives. The shimmer animation is disabled under
 * `prefers-reduced-motion` (handled in CSS), so no JS branch is needed here.
 */
export interface SkeletonProps {
	/** CSS width (a number is treated as px). Defaults to 100%. */
	width?: number | string;
	/** CSS height (a number is treated as px). Defaults to "1em" (or width, when circle). */
	height?: number | string;
	/** Corner radius (a number is treated as px). Ignored when `circle`. Falls back to --radius-sm. */
	radius?: number | string;
	/** Render a pill/circle (avatars, dots). */
	circle?: boolean;
	/**
	 * Animation offset in ms. Use a negative, increasing value across a list
	 * (e.g. index * -150) so a stack of skeletons shimmers as a cascading wave
	 * instead of pulsing in lockstep.
	 */
	delayMs?: number;
	className?: string;
	style?: CSSProperties;
}

function toCss(value: number | string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "number" ? `${value}px` : value;
}

/** A single shimmering placeholder block. */
export function Skeleton({ width, height, radius, circle, delayMs, className, style }: SkeletonProps) {
	const resolvedWidth = toCss(width) ?? "100%";
	return (
		<span
			aria-hidden="true"
			className={className ? `skeleton ${className}` : "skeleton"}
			style={{
				width: resolvedWidth,
				height: toCss(height) ?? (circle ? resolvedWidth : "1em"),
				borderRadius: circle ? "9999px" : toCss(radius),
				animationDelay: delayMs ? `${delayMs}ms` : undefined,
				...style,
			}}
		/>
	);
}

export interface SkeletonTextProps {
	/** Number of lines. */
	lines?: number;
	/** Gap between lines in px. */
	gap?: number;
	/** Width of the final (short) line. The rest are full width, like real text. */
	lastLineWidth?: number | string;
	/** Per-line height. */
	lineHeight?: number | string;
	className?: string;
	style?: CSSProperties;
}

/** A multi-line text placeholder. The last line is shorter so it reads as prose. */
export function SkeletonText({ lines = 3, gap = 8, lastLineWidth = "60%", lineHeight = "0.85em", className, style }: SkeletonTextProps) {
	return (
		<span
			aria-hidden="true"
			className={className ? `skeleton-text ${className}` : "skeleton-text"}
			style={{ display: "flex", flexDirection: "column", gap, ...style }}
		>
			{Array.from({ length: Math.max(1, lines) }, (_, i) => (
				<Skeleton
					key={i}
					height={lineHeight}
					width={i === lines - 1 ? lastLineWidth : "100%"}
					delayMs={i * -150}
				/>
			))}
		</span>
	);
}
