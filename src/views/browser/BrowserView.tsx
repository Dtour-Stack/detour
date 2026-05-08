import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserCommand, SavedLoginEntry } from "../../shared/index";
import { WebClient } from "../_shared/api/client";

type ElectrobunWebviewElement = HTMLElement & {
	webviewId?: number | null;
	loadURL?: (url: string) => void | Promise<void>;
	goBack?: () => void | Promise<void>;
	goForward?: () => void | Promise<void>;
	reload?: () => void | Promise<void>;
	canGoBack?: () => boolean | Promise<boolean>;
	canGoForward?: () => boolean | Promise<boolean>;
	executeJavascript?: (script: string) => void | Promise<void>;
	callAsyncJavaScript?: (input: { script: string }) => unknown | Promise<unknown>;
	syncDimensions?: (force?: boolean) => void | Promise<void>;
	toggleHidden?: (hidden?: boolean) => void | Promise<void>;
	on?: (event: string, listener: EventListener) => void;
	off?: (event: string, listener: EventListener) => void;
	setNavigationRules?: (rules: string[]) => void;
	preload?: string | null;
};

type BrowserTab = {
	id: string;
	url: string;
	address: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
};

type LoginResult = {
	logins: SavedLoginEntry[];
	failures: { source: string; message: string }[];
};

type BrowserWebviewEvent = Event & {
	detail?: string | { url?: string };
	data?: { detail?: string };
};

const DEFAULT_URL = "https://www.google.com";
const PARTITION = "detour-agent-browser";
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;

const DETOUR_BROWSER_PRELOAD_SCRIPT = `
(() => {
  const send = (payload) => {
    try {
      if (typeof window.__electrobunSendToHost === "function") {
        window.__electrobunSendToHost(payload);
      }
    } catch {}
  };
  const cloneable = (value) => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      try {
        return { __unserializable: true, repr: String(value) };
      } catch {
        return { __unserializable: true, repr: "[unprintable]" };
      }
    }
  };
  window.__detourBrowserExec = (requestId, script) => {
    let value;
    try {
      value = (0, eval)(script);
    } catch (error) {
      send({ type: "__detourBrowserExecResult", requestId, ok: false, error: error && error.message ? String(error.message) : String(error) });
      return;
    }
    Promise.resolve(value)
      .then((result) => send({ type: "__detourBrowserExecResult", requestId, ok: true, result: cloneable(result) }))
      .catch((error) => send({ type: "__detourBrowserExecResult", requestId, ok: false, error: error && error.message ? String(error.message) : String(error) }));
  };
})();
`;

const INSPECT_SCRIPT = `(() => {
const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
const text = clean(document.body?.innerText || "").slice(0, 12000);
const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 80).map((a) => ({
  text: clean(a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || ""),
  href: a.href
}));
const buttons = Array.from(document.querySelectorAll("button,input[type=button],input[type=submit],[role=button]")).slice(0, 80).map((el) => ({
  text: clean(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || ""),
  selector: el.id ? "#" + CSS.escape(el.id) : null
}));
const inputs = Array.from(document.querySelectorAll("input,textarea,select")).slice(0, 80).map((el) => ({
  tag: el.tagName.toLowerCase(),
  type: el.getAttribute("type") || "",
  name: el.getAttribute("name") || "",
  id: el.id || "",
  placeholder: el.getAttribute("placeholder") || "",
  autocomplete: el.getAttribute("autocomplete") || ""
}));
return { title: document.title, url: location.href, text, links, buttons, inputs };
})();`;

function makeId(): string {
	return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return DEFAULT_URL;
	if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
	if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(trimmed)) {
		return `https://${trimmed}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function hostnameFor(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.hostname.replace(/^www\./, "") || parsed.protocol.replace(":", "");
	} catch {
		return url;
	}
}

function eventUrl(event: Event): string | null {
	const webviewEvent = event as BrowserWebviewEvent;
	const detail = webviewEvent.detail;
	if (typeof detail === "string") return detail;
	if (typeof detail?.url === "string") return detail.url;
	return webviewEvent.data?.detail ?? null;
}

function hostMessageDetail(event: Event): Record<string, unknown> | null {
	const detail = (event as CustomEvent<unknown>).detail;
	if (!detail) return null;
	if (typeof detail === "object" && !Array.isArray(detail)) return detail as Record<string, unknown>;
	if (typeof detail !== "string") return null;
	try {
		const parsed = JSON.parse(detail) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

function loginKey(login: SavedLoginEntry): string {
	return `${login.source}:${login.identifier}`;
}

function matchesHost(login: SavedLoginEntry, host: string): boolean {
	if (!host) return true;
	const domain = (login.domain ?? "").toLowerCase().replace(/^www\./, "");
	const label = (login.label ?? "").toLowerCase();
	const username = (login.username ?? "").toLowerCase();
	const normalizedHost = host.toLowerCase().replace(/^www\./, "");
	return Boolean(domain && (domain.includes(normalizedHost) || normalizedHost.includes(domain))) || label.includes(normalizedHost) || username.includes(normalizedHost);
}

function buildAutofillScript(input: { username?: string; password?: string; totp?: string }): string {
	const username = JSON.stringify(input.username ?? "");
	const password = JSON.stringify(input.password ?? "");
	const totp = JSON.stringify(input.totp ?? "");
	return `(() => {
const username = ${username};
const password = ${password};
const totp = ${totp};
const visible = (el) => {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
};
const setValue = (el, value) => {
  if (!el || !value) return;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  if (descriptor && typeof descriptor.set === "function") descriptor.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
const userInput = inputs.find((el) => /email|username|user|login/i.test([el.name, el.id, el.autocomplete, el.placeholder, el.type].join(" "))) || inputs.find((el) => ["email", "text"].includes((el.type || "text").toLowerCase()));
const passwordInput = inputs.find((el) => (el.type || "").toLowerCase() === "password");
const otpInput = inputs.find((el) => /otp|totp|2fa|code|one-time/i.test([el.name, el.id, el.autocomplete, el.placeholder].join(" ")));
setValue(userInput, username);
setValue(passwordInput, password);
setValue(otpInput, totp);
})();`;
}

function BrowserWebview(props: {
	tab: BrowserTab;
	active: boolean;
	attach: (id: string, element: ElectrobunWebviewElement | null) => void;
}) {
	const attach = useCallback((element: ElectrobunWebviewElement | null) => {
		props.attach(props.tab.id, element);
	}, [props.attach, props.tab.id]);

	return createElement("electrobun-webview", {
		ref: attach,
		className: props.active ? "agent-browser-webview active" : "agent-browser-webview inactive",
		src: props.tab.url,
		partition: PARTITION,
		preload: DETOUR_BROWSER_PRELOAD_SCRIPT,
	});
}

function useElectrobunWebviewScript(): "loading" | "ready" | "unavailable" {
	const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

	useEffect(() => {
		if (typeof window === "undefined") return;
		let stopped = false;
		let attempts = 0;
		const check = () => {
			if (stopped) return;
			if (customElements.get("electrobun-webview")) {
				setStatus("ready");
				return;
			}
			attempts += 1;
			if (attempts >= 50) {
				setStatus("unavailable");
				return;
			}
			setTimeout(check, 100);
		};
		check();
		return () => {
			stopped = true;
		};
	}, []);

	return status;
}

export function BrowserView() {
	const client = useMemo(() => new WebClient(), []);
	const scriptStatus = useElectrobunWebviewScript();
	const [connected, setConnected] = useState(false);
	const [stageReady, setStageReady] = useState(false);
	const [tabs, setTabs] = useState<BrowserTab[]>(() => {
		const id = makeId();
		return [{
			id,
			url: DEFAULT_URL,
			address: DEFAULT_URL,
			title: hostnameFor(DEFAULT_URL),
			loading: false,
			canGoBack: false,
			canGoForward: false,
		}];
	});
	const [activeTabId, setActiveTabId] = useState(() => tabs[0]?.id ?? "");
	const [addressDraft, setAddressDraft] = useState(DEFAULT_URL);
	const [loginsOpen, setLoginsOpen] = useState(false);
	const [loginData, setLoginData] = useState<LoginResult | null>(null);
	const [loginError, setLoginError] = useState<string | null>(null);
	const [loginBusy, setLoginBusy] = useState<string | null>(null);
	const [statusText, setStatusText] = useState("Ready");
	const webviews = useRef(new Map<string, ElectrobunWebviewElement>());
	const stageRef = useRef<HTMLElement | null>(null);
	const processedCommands = useRef(new Set<string>());
	const pendingNavigation = useRef(new Map<string, string>());
	const pendingFill = useRef(new Map<string, Extract<BrowserCommand, { kind: "fill-login" }>>());
	const execCounter = useRef(0);
	const pendingExecs = useRef(new Map<number, {
		resolve: (result: { ok: boolean; result?: unknown; error?: string }) => void;
		timer: ReturnType<typeof setTimeout>;
	}>());
	const activeTabIdRef = useRef(activeTabId);

	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

	useEffect(() => {
		activeTabIdRef.current = activeTabId;
	}, [activeTabId]);

	const activateTab = useCallback((id: string) => {
		activeTabIdRef.current = id;
		setActiveTabId(id);
	}, []);

	useEffect(() => {
		if (activeTab) setAddressDraft(activeTab.address);
	}, [activeTab?.id, activeTab?.address]);

	const patchTab = useCallback((id: string, patch: Partial<BrowserTab>) => {
		setTabs((current) => {
			let changed = false;
			const entries = Object.entries(patch) as [keyof BrowserTab, BrowserTab[keyof BrowserTab]][];
			const next = current.map((tab) => {
				if (tab.id !== id) return tab;
				if (entries.every(([key, value]) => Object.is(tab[key], value))) return tab;
				changed = true;
				return { ...tab, ...patch };
			});
			return changed ? next : current;
		});
	}, []);

	const refreshNavState = useCallback((id: string) => {
		const view = webviews.current.get(id);
		if (!view) return;
		void Promise.all([
			Promise.resolve(view.canGoBack?.() ?? false).catch(() => false),
			Promise.resolve(view.canGoForward?.() ?? false).catch(() => false),
		]).then(([canGoBack, canGoForward]) => {
			patchTab(id, { canGoBack, canGoForward });
		});
	}, [patchTab]);

	const loadTabUrl = useCallback((id: string, url: string) => {
		pendingNavigation.current.set(id, url);
		const load = () => {
			const view = webviews.current.get(id);
			if (!view?.loadURL || view.webviewId === null) return;
			if (pendingNavigation.current.get(id) !== url) return;
			pendingNavigation.current.delete(id);
			void view.loadURL(url);
		};
		load();
		requestAnimationFrame(load);
		setTimeout(load, 100);
		setTimeout(load, 500);
	}, []);

	const navigateTab = useCallback((id: string, input: string) => {
		const url = normalizeUrl(input);
		patchTab(id, { url, address: url, title: hostnameFor(url), loading: true });
		loadTabUrl(id, url);
		return url;
	}, [loadTabUrl, patchTab]);

	const addTab = useCallback((input = DEFAULT_URL, activate = true): string => {
		const url = normalizeUrl(input);
		const id = makeId();
		setTabs((current) => [
			...current,
			{
				id,
				url,
				address: url,
				title: hostnameFor(url),
				loading: true,
				canGoBack: false,
				canGoForward: false,
			},
		]);
		pendingNavigation.current.set(id, url);
		if (activate) activateTab(id);
		return id;
	}, [activateTab]);

	const closeTab = useCallback((id: string) => {
		setTabs((current) => {
			if (current.length <= 1) return current;
			const index = current.findIndex((tab) => tab.id === id);
			const next = current.filter((tab) => tab.id !== id);
			if (activeTabIdRef.current === id) {
				const fallback = next[Math.max(0, index - 1)] ?? next[0];
				if (fallback) activateTab(fallback.id);
			}
			webviews.current.delete(id);
			pendingNavigation.current.delete(id);
			pendingFill.current.delete(id);
			return next;
		});
	}, [activateTab]);

	const executeInTab = useCallback((
		tabId: string,
		script: string,
		timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
		const view = webviews.current.get(tabId);
		if (!view) return Promise.resolve({ ok: false, error: "Browser tab is not mounted." });
		execCounter.current += 1;
		const requestId = execCounter.current;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!pendingExecs.current.delete(requestId)) return;
				resolve({ ok: false, error: `Browser script timed out after ${timeoutMs}ms` });
			}, timeoutMs);
			pendingExecs.current.set(requestId, { resolve, timer });
			view.executeJavascript?.(
				`window.__detourBrowserExec(${JSON.stringify(requestId)}, ${JSON.stringify(script)})`,
			);
		});
	}, []);

	const fillLogin = useCallback(async (
		command: Extract<BrowserCommand, { kind: "fill-login" }>,
		targetTabId?: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
		const tabId = targetTabId ?? command.tabId ?? activeTabIdRef.current;
		const view = webviews.current.get(tabId);
		if (!view) {
			setStatusText("No active browser tab to fill.");
			return { ok: false, error: "No active browser tab to fill." };
		}
		const key = `${command.source}:${command.identifier}`;
		setLoginBusy(key);
		try {
			const revealed = await client.revealSavedLogin(command.source, command.identifier) as {
				username?: string;
				password?: string;
				totp?: string;
				domain?: string;
				note?: string;
			};
			if (!revealed.password && !revealed.username && !revealed.totp) {
				throw new Error(revealed.note || "This saved login has no autofillable fields.");
			}
			const result = await executeInTab(tabId, buildAutofillScript(revealed), command.timeoutMs);
			if (!result.ok) throw new Error(result.error ?? "Autofill failed.");
			setStatusText(`Filled ${revealed.domain ?? command.source} in the active tab.`);
			return { ok: true, result: { domain: revealed.domain ?? command.source } };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			setStatusText(error);
			return { ok: false, error };
		} finally {
			setLoginBusy(null);
		}
	}, [client, executeInTab]);

	const reportCommandResult = useCallback((command: BrowserCommand, result: { ok: boolean; result?: unknown; error?: string; text?: string }) => {
		void client.reportBrowserCommandResult(command.id, result).catch(() => {});
	}, [client]);

	const handleCommand = useCallback((command: BrowserCommand) => {
		if (processedCommands.current.has(command.id)) return;
		processedCommands.current.add(command.id);
		if (command.kind === "open") {
			const id = command.newTab === false ? activeTabIdRef.current : addTab(command.url, true);
			if (command.newTab === false) navigateTab(id, command.url);
			setStatusText(`Opened ${hostnameFor(command.url)}.`);
			reportCommandResult(command, { ok: true, result: { tabId: id, url: normalizeUrl(command.url) } });
			return;
		}
		if (command.kind === "fill-login") {
			if (command.targetUrl) {
				const tabId = command.newTab === false ? activeTabIdRef.current : addTab(command.targetUrl, true);
				pendingFill.current.set(tabId, command);
				if (command.newTab === false) navigateTab(tabId, command.targetUrl);
				setStatusText("Opening page before autofill.");
				return;
			}
			void fillLogin(command).then((result) => reportCommandResult(command, result));
			return;
		}
		if (command.kind === "inspect" || command.kind === "script") {
			const tabId = command.tabId ?? activeTabIdRef.current;
			const script = command.kind === "inspect" ? INSPECT_SCRIPT : command.script;
			void executeInTab(tabId, script, command.timeoutMs).then((result) => {
				setStatusText(result.ok ? `Browser ${command.kind} complete.` : result.error ?? `Browser ${command.kind} failed.`);
				reportCommandResult(command, result);
			});
		}
	}, [addTab, executeInTab, fillLogin, navigateTab, reportCommandResult]);

	useEffect(() => {
		client
			.connect()
			.then(async () => {
				setConnected(true);
				const since = Date.now() - 30_000;
				const queued = await client.browserCommands({ since });
				for (const command of queued.commands) handleCommand(command);
			})
			.catch((err) => {
				setStatusText(err instanceof Error ? err.message : String(err));
			});
		const off = client.on((message) => {
			if (message.kind === "browser:command") handleCommand(message.command);
		});
		return off;
	}, [client, handleCommand]);

	useEffect(() => {
		const view = webviews.current.get(activeTabId);
		void view?.syncDimensions?.(true);
	}, [activeTabId, scriptStatus]);

	useEffect(() => {
		for (const [tabId, view] of webviews.current.entries()) {
			void view.toggleHidden?.(tabId !== activeTabId);
			void view.syncDimensions?.(true);
		}
	}, [activeTabId, tabs.length]);

	useEffect(() => {
		const sync = () => {
			const rect = stageRef.current?.getBoundingClientRect();
			const ready = Boolean(
				rect &&
				Number.isFinite(rect.width) &&
				Number.isFinite(rect.height) &&
				rect.width > 0 &&
				rect.height > 0,
			);
			setStageReady(ready);
			if (!ready) return;
			for (const view of webviews.current.values()) {
				void view.syncDimensions?.(true);
			}
		};
		const observer = typeof ResizeObserver !== "undefined" && stageRef.current
			? new ResizeObserver(sync)
			: null;
		if (stageRef.current) observer?.observe(stageRef.current);
		window.addEventListener("resize", sync);
		requestAnimationFrame(() => requestAnimationFrame(sync));
		setTimeout(sync, 250);
		setTimeout(sync, 1_000);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", sync);
		};
	}, []);

	useEffect(() => {
		if (!loginsOpen || !activeTab) return;
		client
			.listSavedLogins()
			.then((result) => {
				setLoginData(result as LoginResult);
				setLoginError(null);
			})
			.catch((err) => {
				setLoginError(err instanceof Error ? err.message : String(err));
			});
	}, [client, loginsOpen, activeTab?.url]);

	useEffect(() => () => {
		for (const pending of pendingExecs.current.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, error: "Browser view unmounted." });
		}
		pendingExecs.current.clear();
	}, []);

	const attachWebview = useCallback((id: string, element: ElectrobunWebviewElement | null) => {
		if (!element) {
			webviews.current.delete(id);
			return;
		}
		if (webviews.current.get(id) === element) return;
		webviews.current.set(id, element);
		element.setNavigationRules?.(["^https://*", "^http://*"]);
		const onReady = () => {
			patchTab(id, { loading: false });
			refreshNavState(id);
			const command = pendingFill.current.get(id);
			if (command) {
				pendingFill.current.delete(id);
				void fillLogin(command, id).then((result) => reportCommandResult(command, result));
			}
		};
		const onHostMessage = (event: Event) => {
			const detail = hostMessageDetail(event);
			if (!detail || detail.type !== "__detourBrowserExecResult" || typeof detail.requestId !== "number") return;
			const pending = pendingExecs.current.get(detail.requestId);
			if (!pending) return;
			pendingExecs.current.delete(detail.requestId);
			clearTimeout(pending.timer);
			pending.resolve({
				ok: detail.ok === true,
				...(detail.result !== undefined ? { result: detail.result } : {}),
				...(typeof detail.error === "string" ? { error: detail.error } : {}),
			});
		};
		const onNavigate = (event: Event) => {
			const url = eventUrl(event);
			if (!url) return;
			patchTab(id, {
				url,
				address: url,
				title: hostnameFor(url),
				loading: false,
			});
			refreshNavState(id);
		};
		const onNewWindow = (event: Event) => {
			const url = eventUrl(event);
			if (url) addTab(url, true);
		};
		element.on?.("dom-ready", onReady);
		element.on?.("did-navigate", onNavigate);
		element.on?.("did-navigate-in-page", onNavigate);
		element.on?.("new-window-open", onNewWindow);
		element.on?.("host-message", onHostMessage);
		const sync = () => void element.syncDimensions?.(true);
		void element.toggleHidden?.(id !== activeTabIdRef.current);
		sync();
		requestAnimationFrame(() => requestAnimationFrame(sync));
		setTimeout(sync, 100);
		setTimeout(sync, 250);
		setTimeout(sync, 1_000);
		const loadPending = () => {
			const url = pendingNavigation.current.get(id);
			if (url) loadTabUrl(id, url);
		};
		requestAnimationFrame(loadPending);
		setTimeout(loadPending, 150);
		setTimeout(loadPending, 750);
	}, [addTab, fillLogin, loadTabUrl, patchTab, refreshNavState, reportCommandResult]);

	function submitAddress(event: React.FormEvent) {
		event.preventDefault();
		if (!activeTab) return;
		navigateTab(activeTab.id, addressDraft);
	}

	const currentHost = activeTab ? hostnameFor(activeTab.url) : "";
	const matchingLogins = loginData?.logins.filter((login) => matchesHost(login, currentHost)) ?? [];

	return (
		<div className="agent-browser-shell">
			<header className="agent-browser-header">
				<div className="agent-browser-tabs" role="tablist" aria-label="Browser tabs">
					{tabs.map((tab) => (
						<div
							key={tab.id}
							className={tab.id === activeTabId ? "agent-browser-tab active" : "agent-browser-tab"}
						>
							<button
								type="button"
								role="tab"
								aria-selected={tab.id === activeTabId}
								onClick={() => activateTab(tab.id)}
								title={tab.address}
							>
								<span>{tab.loading ? "..." : tab.title}</span>
							</button>
							{tabs.length > 1 && (
								<button
									type="button"
									className="agent-browser-tab-close"
									onClick={(event) => {
										event.stopPropagation();
										closeTab(tab.id);
									}}
									aria-label={`Close ${tab.title}`}
								>
									x
								</button>
							)}
						</div>
					))}
					<button type="button" className="agent-browser-new-tab" onClick={() => addTab()} title="New tab">
						+
					</button>
				</div>
				<div className="agent-browser-toolbar">
					<button type="button" onClick={() => activeTab && webviews.current.get(activeTab.id)?.goBack?.()} disabled={!activeTab?.canGoBack} title="Back">
						&lt;
					</button>
					<button type="button" onClick={() => activeTab && webviews.current.get(activeTab.id)?.goForward?.()} disabled={!activeTab?.canGoForward} title="Forward">
						&gt;
					</button>
					<button type="button" onClick={() => activeTab && webviews.current.get(activeTab.id)?.reload?.()} title="Reload">
						Reload
					</button>
					<form className="agent-browser-address" onSubmit={submitAddress}>
						<label htmlFor="agent-browser-address-input">Address</label>
						<input
							id="agent-browser-address-input"
							type="text"
							value={addressDraft}
							onChange={(event) => setAddressDraft(event.target.value)}
							autoComplete="url"
							spellCheck={false}
						/>
						<button type="submit">Go</button>
					</form>
					<button type="button" onClick={() => setLoginsOpen((open) => !open)} title="Saved logins">
						Logins
					</button>
				</div>
			</header>
			<main className="agent-browser-main">
				<section ref={stageRef} className="agent-browser-stage" aria-label="Browser content">
					{scriptStatus === "unavailable" ? (
						<div className="agent-browser-unavailable">
							<strong>Electrobun webviews are unavailable in this renderer.</strong>
							<span>Open this from the Detour app window to load isolated browser tabs.</span>
						</div>
						) : (
							scriptStatus === "ready" && stageReady && tabs.map((tab) => (
								<BrowserWebview
									key={tab.id}
									tab={tab}
								active={tab.id === activeTabId}
								attach={attachWebview}
							/>
						))
					)}
						{scriptStatus !== "unavailable" && (scriptStatus === "loading" || !stageReady) && (
							<div className="agent-browser-loading">Loading browser engine...</div>
						)}
				</section>
				{loginsOpen && (
					<aside className="agent-browser-logins">
						<div className="agent-browser-logins-head">
							<div>
								<strong>Saved logins</strong>
								<span>{currentHost || "current tab"}</span>
							</div>
							<button type="button" onClick={() => setLoginsOpen(false)}>Close</button>
						</div>
						{loginError && <div className="banner error">{loginError}</div>}
						{!loginData && !loginError && <div className="hint">Loading saved logins...</div>}
						{loginData?.failures.map((failure) => (
							<div key={failure.source} className="banner warn">
								<strong>{failure.source}</strong>: {failure.message}
							</div>
						))}
						{loginData && matchingLogins.length === 0 && (
							<div className="empty">No saved login matched this tab.</div>
						)}
						{matchingLogins.map((login) => {
							const key = loginKey(login);
							return (
								<button
									type="button"
									key={key}
									className="agent-browser-login-row"
									onClick={() => void fillLogin({
										id: makeId(),
										time: Date.now(),
										kind: "fill-login",
										source: login.source,
										identifier: login.identifier,
									})}
									disabled={loginBusy === key}
								>
									<span>{login.label ?? login.domain ?? login.identifier}</span>
									<small>{login.username ?? login.source}</small>
								</button>
							);
						})}
					</aside>
				)}
			</main>
			<footer className="agent-browser-status">
				<span>{connected ? "connected" : "connecting"}</span>
				<span>{statusText}</span>
				<span>partition: {PARTITION}</span>
			</footer>
		</div>
	);
}
