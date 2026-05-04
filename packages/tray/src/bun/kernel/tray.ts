import { Tray } from "electrobun/bun";

type MenuItem = { label: string; action: string; order?: number };
type ClickHandler = (action: string) => void;

const QUIT_ACTION = "__quit__";

export class TrayController {
	private tray: Tray;
	private items: MenuItem[] = [];
	private handlers = new Map<string, ClickHandler>();
	private iconClickHandlers: Array<() => void> = [];

	constructor(opts: { title: string }) {
		// Template PNGs are copied to Resources/app/views/icons/ by the
		// electrobun.config.ts copy map. The `views://` prefix is what Tray's
		// resolveImagePath understands; macOS auto-picks @2x / @3x by suffix.
		// `template: true` → auto-tint for light/dark menu bar.
		// `title: ""` → image-only (passing opts.title here would render the
		// app name as text alongside the icon).
		this.tray = new Tray({
			title: "",
			image: "views://icons/iconTemplate.png",
			template: true,
			width: 22,
			height: 22,
		});
		void opts.title; // kept on the public API in case callers want to setTitle later
		this.tray.on("tray-clicked", (event: any) => {
			const action: string = event?.data?.action ?? "";
			if (action === "") {
				for (const h of this.iconClickHandlers) h();
				return;
			}
			if (action === QUIT_ACTION) {
				this.remove();
				process.exit(0);
				return;
			}
			const handler = this.handlers.get(action);
			handler?.(action);
		});
	}

	addMenuItem(item: MenuItem, handler: ClickHandler): void {
		this.items.push(item);
		this.handlers.set(item.action, handler);
		this.rebuildMenu();
	}

	onIconClicked(handler: () => void): void {
		this.iconClickHandlers.push(handler);
	}

	getBounds() {
		return this.tray.getBounds();
	}

	remove(): void {
		this.tray.remove();
	}

	private rebuildMenu(): void {
		const sorted = [...this.items].sort(
			(a, b) => (a.order ?? 100) - (b.order ?? 100),
		);
		const menu = sorted.flatMap((item, idx) => {
			const isLast = idx === sorted.length - 1;
			return [
				{ type: "normal" as const, label: item.label, action: item.action },
				...(isLast ? [{ type: "divider" as const }] : []),
			];
		});
		menu.push({ type: "normal" as const, label: "Quit", action: QUIT_ACTION });
		this.tray.setMenu(menu);
	}
}
