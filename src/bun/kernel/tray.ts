import { Tray } from "electrobun/bun";

type MenuItem = { label: string; action: string; order?: number };
type ClickHandler = (action: string) => void;

const QUIT_ACTION = "__quit__";

export class TrayController {
	private tray: Tray;
	private items: MenuItem[] = [];
	private handlers = new Map<string, ClickHandler>();
	private iconClickHandlers: Array<() => void> = [];
	private statusLabel: string | null = null;
	private visible = true;

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

	/** Sets a non-clickable status label at the top of the menu. Pass null to hide. */
	setStatus(label: string | null): void {
		if (this.statusLabel === label) return;
		this.statusLabel = label;
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

	hideIcon(): void {
		if (!this.visible) return;
		this.visible = false;
		try {
			this.tray.setVisible(false);
		} catch {
			// best-effort — some Electrobun versions may not expose setVisible.
		}
	}

	private rebuildMenu(): void {
		const sorted = [...this.items].sort(
			(a, b) => (a.order ?? 100) - (b.order ?? 100),
		);
		const menu: Array<
			| { type: "normal"; label: string; action?: string; enabled?: boolean }
			| { type: "divider" }
		> = [];
		if (this.statusLabel !== null) {
			menu.push({ type: "normal", label: this.statusLabel, enabled: false });
			menu.push({ type: "divider" });
		}
		for (let i = 0; i < sorted.length; i += 1) {
			const item = sorted[i]!;
			menu.push({ type: "normal", label: item.label, action: item.action });
			if (i === sorted.length - 1) menu.push({ type: "divider" });
		}
		menu.push({ type: "normal", label: "Quit", action: QUIT_ACTION });
		this.tray.setMenu(menu);
	}
}
