/**
 * PreviewServerRegistry — per-project Bun.serve static-file server,
 * registered with PortlessService so previews land at stable
 * `http://<slug>.localhost:<portlessProxyPort>/` URLs.
 *
 * Behavior per project type/template:
 *   - `page/static`     → serves project root (index.html lives there).
 *   - `app/carrot`      → serves `<project>/web/` (index.html lives there).
 *   - `app/nextjs`      → not handled here. The agent runs `bun dev`
 *                         itself via BASH and registers the dev port
 *                         via `registerExternalPort()`.
 *
 * One server per slug. Re-starting reuses the existing port. Stopping
 * removes the portless route and shuts down the listener.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { PortlessService } from "./portless";
import { projectDir, readProjectMeta } from "./agent-projects-core";

type BunServer = ReturnType<typeof Bun.serve>;
type ChildProc = ReturnType<typeof Bun.spawn>;

export type PreviewKind = "static-root" | "static-web" | "external";

export type PreviewState = {
	slug: string;
	kind: PreviewKind;
	port: number;
	hostname: string;
	url: string;
	publicUrl?: string;
	publicUrlProvider?: "ngrok";
	publicUrlPid?: number;
	publicUrlStartedAt?: number;
	publicUrlError?: string;
	rootDir: string | null; // null when external (port pre-bound by agent's bun-dev process)
	startedAt: number;
};

const MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
};

function mimeFor(path: string): string {
	return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function safeJoinUnderRoot(rootAbs: string, relPath: string): string | null {
	const decoded = decodeURIComponent(relPath);
	const joined = normalize(join(rootAbs, decoded));
	const rootResolved = resolve(rootAbs);
	if (joined !== rootResolved && !joined.startsWith(rootResolved + sep)) return null;
	return joined;
}

/**
 * Hostname stored in the portless route store must be the FULL
 * hostname (slug + tld) — portless's strict-mode `findRoute` does
 * `r.hostname === requestHost`, and the request's Host header is
 * `<slug>.localhost`. Storing just the slug means the lookup fails.
 */
function hostnameForSlug(slug: string, tld: string): string {
	return `${slug.toLowerCase()}.${tld}`;
}

function urlForRoute(hostname: string, proxyPort: number): string {
	// Drop the port when it's HTTP/HTTPS default — gives the port-less
	// experience portless is for. When the standalone daemon is on 443
	// (its canonical port), URLs become `https://<slug>.localhost/`.
	if (proxyPort === 443) return `https://${hostname}/`;
	if (proxyPort === 80) return `http://${hostname}/`;
	return `http://${hostname}:${proxyPort}/`;
}

export class PreviewServerRegistry {
	private servers = new Map<string, { state: PreviewState; server: BunServer | null; child: ChildProc | null; ngrok: ChildProc | null }>();
	/** In-flight start promises keyed by slug. A second concurrent
	 * startStatic() call awaits the existing promise instead of
	 * spawning a duplicate dev server (the duplicate would race for
	 * `.next/dev/lock`, lose, and our exit-watcher would tear down
	 * the survivor's route). */
	private starting = new Map<string, Promise<PreviewState>>();

	constructor(private readonly portless: PortlessService) {}

	list(): PreviewState[] {
		return Array.from(this.servers.values()).map((s) => s.state);
	}

	get(slug: string): PreviewState | null {
		return this.servers.get(slug)?.state ?? null;
	}

	/**
	 * Start (or re-use) a static-file preview for the project. Picks the
	 * right rootDir from project meta; throws when the project type can't
	 * be statically previewed (e.g. nextjs — run `bun dev` and call
	 * registerExternalPort instead).
	 */
	/**
	 * Start (or re-use) a preview for the project. Dispatches to:
	 *   - startStaticInternal for page/static + app/carrot
	 *   - startNextjsDev for app/nextjs (auto `bun install` + `bun dev`)
	 */
	async startStatic(slug: string): Promise<PreviewState> {
		const existing = this.servers.get(slug);
		if (existing) return existing.state;
		const inflight = this.starting.get(slug);
		if (inflight) return inflight;

		const promise = this.startStaticInternal(slug);
		this.starting.set(slug, promise);
		try {
			return await promise;
		} finally {
			this.starting.delete(slug);
		}
	}

	private async startStaticInternal(slug: string): Promise<PreviewState> {
		const existing = this.servers.get(slug);
		if (existing) return existing.state;

		const meta = readProjectMeta(slug);
		if (!meta) throw new Error(`project not found: ${slug}`);

		if (meta.template === "nextjs") {
			return this.startNextjsDev(slug);
		}

		const baseDir = projectDir(slug);
		let rootDir: string;
		let kind: PreviewKind;
		if (meta.type === "page") {
			rootDir = baseDir;
			kind = "static-root";
		} else if (meta.template === "carrot" || !meta.template) {
			rootDir = join(baseDir, "web");
			kind = "static-web";
		} else {
			throw new Error(`unsupported template for static preview: ${meta.template}`);
		}
		if (!existsSync(rootDir)) {
			throw new Error(`preview root does not exist: ${rootDir}`);
		}

		const rootAbs = resolve(rootDir);
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				const u = new URL(req.url);
				let pathname = u.pathname;
				if (pathname === "/" || pathname === "") pathname = "/index.html";
				const target = safeJoinUnderRoot(rootAbs, pathname.replace(/^\/+/, ""));
				if (!target) return new Response("Forbidden", { status: 403 });
				try {
					const st = statSync(target);
					if (st.isDirectory()) {
						const index = join(target, "index.html");
						if (!existsSync(index)) return new Response("Not Found", { status: 404 });
						return new Response(readFileSync(index), {
							headers: { "Content-Type": "text/html; charset=utf-8" },
						});
					}
					return new Response(readFileSync(target), {
						headers: { "Content-Type": mimeFor(target) },
					});
				} catch {
					return new Response("Not Found", { status: 404 });
				}
			},
		});

		const port = server.port;
		if (typeof port !== "number") {
			server.stop(true);
			throw new Error("Bun.serve did not return a port");
		}
		const hostname = hostnameForSlug(slug, this.portless.snapshot().tld);
		try {
			// Cleanup: remove any legacy slug-only entry from earlier
			// detour versions that stored hostnames without the tld.
			try { this.portless.removeRoute(slug.toLowerCase()); } catch { /* ignore */ }
			this.portless.addRoute(hostname, port, { force: true });
		} catch (err) {
			server.stop(true);
			throw err instanceof Error ? err : new Error(String(err));
		}

		const state: PreviewState = {
			slug,
			kind,
			port,
			hostname,
			url: urlForRoute(hostname, this.portless.snapshot().proxyPort),
			rootDir: rootAbs,
			startedAt: Date.now(),
		};
		this.servers.set(slug, { state, server, child: null, ngrok: null });
		return state;
	}

	/**
	 * Boot a Next.js dev server (`bun install` if `node_modules` is
	 * missing, then `bun run dev`) and register the bound port with
	 * portless. The dev server's stdout is parsed for the listening
	 * port — Next.js auto-picks one when 3000 is taken.
	 */
	async startNextjsDev(slug: string): Promise<PreviewState> {
		const existing = this.servers.get(slug);
		if (existing) return existing.state;

		const meta = readProjectMeta(slug);
		if (!meta) throw new Error(`project not found: ${slug}`);
		const dir = projectDir(slug);
		if (!existsSync(dir)) throw new Error(`project dir missing: ${dir}`);

		// 0. Reap any straggler `next dev` from a previous run that
		//    didn't release the lockfile. We scope by cwd to avoid
		//    touching unrelated next dev processes the user may have
		//    running for other repos.
		await reapStaleNextDev(dir);

		// 1. Install deps if needed. node_modules being absent is the
		//    only signal we use; we don't try to detect partial installs.
		if (!existsSync(join(dir, "node_modules"))) {
			console.log(`[preview] bun install in ${dir}…`);
			const installProc = Bun.spawn(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
			const stderr = await new Response(installProc.stderr).text();
			const code = await installProc.exited;
			if (code !== 0) {
				throw new Error(`bun install failed: ${stderr.trim().slice(0, 240)}`);
			}
		}

		// 2. Spawn `bun run dev`. Pin the port we want — Next.js takes
		//    `-p`. We let portless route `<slug>.localhost:4848` → this.
		const devPort = await pickFreePort();
		console.log(`[preview] starting next dev for ${slug} on :${devPort}`);
		const child = Bun.spawn(["bun", "run", "dev", "--", "-p", String(devPort)], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PORT: String(devPort) },
		});

		// 3. Wait for the dev server to actually listen — TCP probe loop.
		try {
			await waitForPort(devPort, 60_000);
		} catch (err) {
			try { child.kill(); } catch { /* ignore */ }
			const stderrStream = child.stderr && typeof child.stderr === "object" && "getReader" in child.stderr
				? (child.stderr as ReadableStream<Uint8Array>)
				: null;
			const stderrTail = await readStreamHead(stderrStream, 400);
			throw new Error(
				`Next.js dev server didn't start on :${devPort} within 60s${stderrTail ? `: ${stderrTail}` : ""}. Run \`bun dev\` manually in ${dir} to see what's wrong.`,
			);
		}

		// 4. Register with portless.
		const hostname = hostnameForSlug(slug, this.portless.snapshot().tld);
		try { this.portless.removeRoute(slug.toLowerCase()); } catch { /* ignore */ }
		this.portless.addRoute(hostname, devPort, { force: true });
		const state: PreviewState = {
			slug,
			kind: "external",
			port: devPort,
			hostname,
			url: urlForRoute(hostname, this.portless.snapshot().proxyPort),
			rootDir: null,
			startedAt: Date.now(),
		};
		this.servers.set(slug, { state, server: null, child, ngrok: null });

		// Watch the child for unexpected exit (crash, OOM, port collision
		// after-the-fact). When it dies, drop the route so requests stop
		// returning 502 and start returning 404 — at least the user knows
		// the server is gone, not stuck.
		void child.exited.then((code) => {
			if (this.servers.get(slug)?.child === child) {
				console.warn(`[preview] ${slug} dev server exited (code=${code}). Removing route.`);
				try { this.portless.removeRoute(hostname); } catch { /* ignore */ }
				this.servers.delete(slug);
			}
		}).catch(() => { /* ignore */ });

		// Pipe child stderr to the host log so failures surface in the
		// dev terminal instead of vanishing into the spawn buffer.
		void pipeChildOutput(`[preview:${slug}]`, child);

		return state;
	}

	/**
	 * Register a port the agent already owns (e.g. `bun dev` running in
	 * the project dir) under the project's portless hostname so the
	 * dev server is reachable at the same stable URL pattern as static
	 * previews.
	 */
	registerExternalPort(slug: string, port: number): PreviewState {
		const meta = readProjectMeta(slug);
		if (!meta) throw new Error(`project not found: ${slug}`);
		// Replace any prior in-process server.
		const prior = this.servers.get(slug);
		if (prior?.server) {
			try { prior.server.stop(true); } catch { /* ignore */ }
		}
		if (prior?.child) {
			try { prior.child.kill(); } catch { /* ignore */ }
		}
		const hostname = hostnameForSlug(slug, this.portless.snapshot().tld);
		try { this.portless.removeRoute(slug.toLowerCase()); } catch { /* ignore */ }
		this.portless.addRoute(hostname, port, { force: true });
		const state: PreviewState = {
			slug,
			kind: "external",
			port,
			hostname,
			url: urlForRoute(hostname, this.portless.snapshot().proxyPort),
			rootDir: null,
			startedAt: Date.now(),
		};
		this.servers.set(slug, { state, server: null, child: null, ngrok: null });
		return state;
	}

	async startPublic(slug: string): Promise<PreviewState> {
		const state = await this.startStatic(slug);
		const entry = this.servers.get(slug);
		if (!entry) throw new Error(`preview not running for ${slug}`);
		if (entry.ngrok && state.publicUrl) return state;

		if (entry.ngrok) {
			try { entry.ngrok.kill(); } catch { /* ignore */ }
			entry.ngrok = null;
		}

		delete state.publicUrl;
		delete state.publicUrlProvider;
		delete state.publicUrlPid;
		delete state.publicUrlStartedAt;
		delete state.publicUrlError;

		const bin = await resolveNgrokBinary();
		const args = ngrokArgsForPort(state.port);
		const child = Bun.spawn([bin, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		entry.ngrok = child;

		try {
			const publicUrl = await waitForNgrokPublicUrl(child, 30_000);
			state.publicUrl = publicUrl;
			state.publicUrlProvider = "ngrok";
			state.publicUrlPid = child.pid;
			state.publicUrlStartedAt = Date.now();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			state.publicUrlError = message;
			if (this.servers.get(slug)?.ngrok === child) entry.ngrok = null;
			try { child.kill(); } catch { /* ignore */ }
			throw new Error(`ngrok public preview failed: ${message}`);
		}

		void child.exited.then((code) => {
			const current = this.servers.get(slug);
			if (current?.ngrok !== child) return;
			current.ngrok = null;
			if (current.state.publicUrl) {
				current.state.publicUrlError = `ngrok exited with code ${code}`;
				delete current.state.publicUrl;
				delete current.state.publicUrlProvider;
				delete current.state.publicUrlPid;
				delete current.state.publicUrlStartedAt;
			}
		}).catch(() => { /* ignore */ });

		return state;
	}

	async stop(slug: string): Promise<void> {
		const entry = this.servers.get(slug);
		if (!entry) return;
		try { entry.server?.stop(true); } catch { /* ignore */ }
		try { entry.child?.kill(); } catch { /* ignore */ }
		try { entry.ngrok?.kill(); } catch { /* ignore */ }
		try { this.portless.removeRoute(entry.state.hostname); } catch { /* ignore */ }
		this.servers.delete(slug);
	}

	async stopAll(): Promise<void> {
		for (const slug of Array.from(this.servers.keys())) {
			await this.stop(slug);
		}
	}
}

/**
 * Find any straggler `next dev` (or its child workers) whose working
 * directory is `dir`, kill them, and clear the lockfile. Scoped by
 * cwd so we don't touch the user's unrelated next dev processes.
 *
 * The likely cause of stragglers: a previous `Start server` cycle
 * killed our wrapper child but Next.js spawned a worker that survived,
 * holding `.next/dev/lock`.
 */
async function reapStaleNextDev(dir: string): Promise<void> {
	const fs = await import("node:fs");
	// Find candidate PIDs whose cwd points at this project dir.
	// `lsof +D <dir>` lists processes with any open file under <dir>;
	// far broader than what we want but reliable across macOS/Linux.
	let candidatePids = new Set<number>();
	try {
		const proc = Bun.spawn(["lsof", "+D", dir, "-Fpc"], { stdout: "pipe", stderr: "ignore" });
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		// `-Fpc` outputs lines like `p1234\nccommandname`. Pair each p
		// with the next c. We only kill nodes whose command is a next
		// dev variant: node, bun, or next.
		const lines = stdout.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line.startsWith("p")) continue;
			const pid = Number(line.slice(1));
			if (!Number.isFinite(pid) || pid <= 0) continue;
			const next = lines[i + 1];
			if (!next?.startsWith("c")) continue;
			const cmd = next.slice(1).toLowerCase();
			if (cmd.includes("node") || cmd.includes("bun") || cmd.includes("next")) {
				candidatePids.add(pid);
			}
		}
	} catch { /* lsof not available — fall through to lockfile cleanup */ }

	// Don't kill ourselves.
	candidatePids.delete(process.pid);
	for (const pid of candidatePids) {
		try {
			process.kill(pid, "SIGTERM");
			console.log(`[preview] reaped stale next-dev PID ${pid} (cwd=${dir})`);
		} catch { /* already dead */ }
	}
	if (candidatePids.size > 0) {
		// Give SIGTERM a brief window before forcing.
		await new Promise((r) => setTimeout(r, 500));
		for (const pid of candidatePids) {
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
	}

	// Clean up the lockfile if it's still there.
	const lockPath = `${dir}/.next/dev/lock`;
	try {
		if (fs.existsSync(lockPath)) {
			fs.unlinkSync(lockPath);
			console.log(`[preview] removed stale lockfile ${lockPath}`);
		}
	} catch { /* ignore */ }
}

async function pickFreePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port;
	probe.stop(true);
	if (typeof port !== "number") throw new Error("could not allocate a free port");
	return port;
}

async function resolveNgrokBinary(): Promise<string> {
	const configured = process.env.DETOUR_NGROK_BIN?.trim() || process.env.NGROK_BIN?.trim();
	if (configured) return configured;
	try {
		const proc = Bun.spawn(["which", "ngrok"], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code === 0 && out.trim().length > 0) return out.trim();
	} catch { /* ignore */ }
	throw new Error("ngrok CLI not found. Install ngrok or set DETOUR_NGROK_BIN/NGROK_BIN.");
}

export function ngrokArgsForPort(port: number): string[] {
	const args = ["http", `http://127.0.0.1:${port}`, "--log=stdout", "--log-format=json"];
	const domain = process.env.DETOUR_NGROK_DOMAIN?.trim() || process.env.NGROK_DOMAIN?.trim();
	if (domain) args.push(`--domain=${domain}`);
	return args;
}

export function parseNgrokTunnelUrlLine(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as { url?: string };
		const url = normalizePublicHttpsUrl(parsed.url ?? "");
		if (url) return url;
	} catch { /* not json */ }
	const match = trimmed.match(/https:\/\/[^\s"']*ngrok[^\s"']*/i);
	return normalizePublicHttpsUrl(match?.[0] ?? "");
}

function normalizePublicHttpsUrl(raw: string): string | null {
	if (!raw.startsWith("https://")) return null;
	try {
		const url = new URL(raw);
		return `${url.origin}/`;
	} catch {
		return null;
	}
}

function parseNgrokErrorLine(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as { lvl?: string; level?: string; msg?: string; err?: string; error?: string };
		const level = (parsed.lvl ?? parsed.level ?? "").toLowerCase();
		const detail = [parsed.msg, parsed.err, parsed.error].filter((v): v is string => typeof v === "string" && v.length > 0).join(": ");
		if (detail && (level.includes("err") || /failed|error|authtoken|unauthorized|ERR_NGROK/i.test(detail))) return detail;
	} catch { /* not json */ }
	if (/failed|error|authtoken|unauthorized|ERR_NGROK/i.test(trimmed)) return trimmed.slice(0, 500);
	return null;
}

type ReadableStreamLike = ReadableStream<Uint8Array> | { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | number | null | undefined;

function asReadableStream(value: ReadableStreamLike): ReadableStream<Uint8Array> | null {
	return value && typeof value === "object" && typeof value.getReader === "function"
		? (value as ReadableStream<Uint8Array>)
		: null;
}

async function waitForNgrokPublicUrl(child: ChildProc, timeoutMs: number): Promise<string> {
	return await new Promise((resolve, reject) => {
		let done = false;
		const errors: string[] = [];
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			fn();
		};
		const fail = (message: string) => finish(() => reject(new Error(message)));
		const pass = (url: string) => finish(() => resolve(url));
		const timeoutMessage = () => {
			const detail = errors.length > 0 ? ` Last ngrok output: ${errors.slice(-2).join(" | ")}` : "";
			return `timed out waiting for ngrok public URL.${detail}`;
		};
		const timer = setTimeout(() => fail(timeoutMessage()), timeoutMs);
		const handleLine = (line: string) => {
			const url = parseNgrokTunnelUrlLine(line);
			if (url) {
				pass(url);
				return;
			}
			const error = parseNgrokErrorLine(line);
			if (error) errors.push(error);
		};
		const consume = (stream: ReadableStream<Uint8Array> | null) => {
			if (!stream) return;
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			void (async () => {
				try {
					while (true) {
						const { value, done: streamDone } = await reader.read();
						if (streamDone) break;
						buffer += decoder.decode(value, { stream: true });
						let nl: number;
						while ((nl = buffer.indexOf("\n")) !== -1) {
							const line = buffer.slice(0, nl);
							buffer = buffer.slice(nl + 1);
							handleLine(line);
						}
					}
					if (buffer.trim().length > 0) handleLine(buffer);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push(message);
				} finally {
					try { reader.releaseLock(); } catch { /* ignore */ }
				}
			})();
		};
		consume(asReadableStream(child.stdout));
		consume(asReadableStream(child.stderr));
		void child.exited.then((code) => {
			if (!done) {
				const detail = errors.length > 0 ? ` ${errors.slice(-2).join(" | ")}` : "";
				fail(`ngrok exited before publishing a URL (code ${code}).${detail}`);
			}
		}).catch((err) => {
			if (!done) fail(err instanceof Error ? err.message : String(err));
		});
	});
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const sock = await Bun.connect({
				hostname: "127.0.0.1",
				port,
				socket: { open: () => {}, data: () => {}, close: () => {}, error: () => {} },
			});
			sock.end();
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	throw new Error(`timed out waiting for :${port}`);
}

async function pipeChildOutput(prefix: string, child: ChildProc): Promise<void> {
	const tail = (stream: ReadableStream<Uint8Array> | undefined | null, fn: (line: string) => void) => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		(async () => {
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let nl: number;
					while ((nl = buf.indexOf("\n")) !== -1) {
						const line = buf.slice(0, nl);
						buf = buf.slice(nl + 1);
						if (line.trim().length > 0) fn(line);
					}
				}
				if (buf.trim().length > 0) fn(buf);
			} catch { /* ignore */ }
			try { reader.releaseLock(); } catch { /* ignore */ }
		})();
	};
	const asStream = (s: unknown): ReadableStream<Uint8Array> | null =>
		s && typeof s === "object" && "getReader" in s
			? (s as ReadableStream<Uint8Array>)
			: null;
	tail(asStream(child.stdout), (line) => console.log(`${prefix} ${line}`));
	tail(asStream(child.stderr), (line) => console.warn(`${prefix} ${line}`));
}

async function readStreamHead(stream: ReadableStream<Uint8Array> | undefined | null, maxBytes: number): Promise<string> {
	if (!stream) return "";
	try {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (total < maxBytes) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				total += value.length;
			}
		}
		try { reader.releaseLock(); } catch { /* ignore */ }
		const merged = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) { merged.set(c, off); off += c.length; }
		return new TextDecoder().decode(merged).trim();
	} catch {
		return "";
	}
}

/**
 * Module-level singleton so plugin actions (which don't get an
 * RpcDeps reference) can reach the registry. Set by core/index.ts
 * after construction; null until then.
 */
let registrySingleton: PreviewServerRegistry | null = null;

export function setPreviewRegistry(reg: PreviewServerRegistry): void {
	registrySingleton = reg;
}

export async function getPreviewRegistry(): Promise<PreviewServerRegistry> {
	if (!registrySingleton) throw new Error("preview registry not initialized yet");
	return registrySingleton;
}
