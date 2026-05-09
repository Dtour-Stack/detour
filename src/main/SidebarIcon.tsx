/**
 * SidebarIcon — small, monochromatic 18x18 SVGs used as the collapsed-
 * state visual for `.settings-sidebar` section headers. Stroke is
 * `currentColor` so they tint with the parent button's color (muted /
 * active / hover states all just work).
 */

import type { ReactNode } from "react";

type IconName =
	| "gear"
	| "vault"
	| "cloud"
	| "pulse"
	| "wave"
	| "book"
	| "chat"
	| "tasks"
	| "key"
	| "tools";

const PATHS: Record<IconName, ReactNode> = {
	gear: (
		<>
			<circle cx="9" cy="9" r="2.5" />
			<path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.6 3.6l1.4 1.4M13 13l1.4 1.4M3.6 14.4l1.4-1.4M13 5l1.4-1.4" />
		</>
	),
	vault: (
		<>
			<rect x="2.5" y="3.5" width="13" height="11" rx="1.5" />
			<circle cx="9" cy="9" r="2.5" />
			<path d="M9 6.5v-1M9 12.5v-1M5.5 9H4.5M13.5 9H12.5" />
		</>
	),
	cloud: (
		<path d="M5 13.5h8a3 3 0 0 0 .4-5.97A4.5 4.5 0 0 0 5 8 3 3 0 0 0 5 13.5z" />
	),
	pulse: (
		<path d="M2 9h3l1.5-3 3 6L12 9h4" />
	),
	wave: (
		<path d="M2 9h2M14 9h2M5 6v6M8 4v10M11 6v6" />
	),
	book: (
		<>
			<path d="M3 3h6.5a2 2 0 0 1 2 2v10H5a2 2 0 0 1-2-2V3z" />
			<path d="M11.5 5H15v8.5H11.5z" />
		</>
	),
	chat: (
		<>
			<path d="M2.5 4h11v8h-7l-4 3z" />
			<path d="M5.5 7h5M5.5 9h3" />
		</>
	),
	tasks: (
		<>
			<rect x="3" y="3" width="12" height="12" rx="1.5" />
			<path d="M5.5 7l1.5 1.5L10 5.5M5.5 11l1.5 1.5L10 9.5" />
		</>
	),
	key: (
		<>
			<circle cx="6" cy="9" r="3" />
			<path d="M9 9h6M13.5 9v2M15 9v1.5" />
		</>
	),
	tools: (
		<path d="M3.5 14.5l4-4M11 7l3-3 1 1-3 3M5 13l-1 1 1 1 1-1M9.5 9.5l3 3 2-2-3-3" />
	),
};

export function SidebarIcon({ name }: { name: IconName }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 18 18"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{PATHS[name]}
		</svg>
	);
}

export type { IconName };
