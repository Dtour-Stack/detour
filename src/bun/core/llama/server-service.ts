/**
 * LlamaServerService — manages a `llama-server` subprocess that exposes an
 * OpenAI-compatible HTTP API on localhost. We use it for:
 *
 *   - TEXT_EMBEDDING (primary path for Codex/ChatGPT users — Codex has no
 *     embeddings endpoint, this fills that gap with zero per-call cost).
 *   - Optional local chat fallback (future — same binary supports
 *     /v1/chat/completions when started without --embedding).
 *
 * Architecture
 *   - Lazy: spawned on first ensureRunning() call, never auto-stopped.
 *   - Single instance per process; concurrent ensureRunning() calls dedupe
 *     via the in-flight Promise.
 *   - Binary location: <bunDir>/llama/llama-server in the bundled .app
 *     (electrobun.config.ts copies build-assets/llama → bun/llama).
 *   - Model storage: ${ELIZA_STATE_DIR}/llama/models/*.gguf — auto-downloaded
 *     from HuggingFace on first use.
 *   - Port: bound to 127.0.0.1 on a random ephemeral port. Tracked in state
 *     so the embedding plugin can read OPENAI_EMBEDDING_URL.
 *
 * Why prefer a server over per-call subprocess: the embedding model has to
 * be loaded into RAM each spawn (~80-200 ms for a small model). With a
 * persistent server the model is loaded once and stays warm — embedding
 * latency drops to single-digit ms after warmup.
 *
 * Default model: bge-small-en-v1.5 GGUF Q4_K_M (~25 MB, 384 dim) — chosen
 * for the "hardly any effect" criterion. Override via LLAMA_EMBEDDING_MODEL
 * setting/env var (must be a hf:// reference).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_MODEL_REF = "hf://CompendiumLabs/bge-small-en-v1.5-gguf/bge-small-en-v1.5-q4_k_m.gguf";
const MIN_MODEL_BYTES = 5 * 1024 * 1024; // <5 MB = aborted download
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_PATH = "/health";

export interface LlamaServerConfig {
	/** Override binary directory. Defaults to <bunDir>/llama next to the running script. */
	readonly binaryDir?: string;
	/** Override model dir. Defaults to ${ELIZA_STATE_DIR}/llama/models. */
	readonly modelsDir?: string;
	/** HuggingFace ref `hf://user/repo/path/to/model.gguf`. */
	readonly modelRef?: string;
	/** Embedding-only mode (default). Set to false to also expose chat completion endpoints. */
	readonly embeddingOnly?: boolean;
	/** Number of CPU threads. Default: bun's default (typically all cores). */
	readonly threads?: number;
	/** Context size. Default: 512 (small for embeddings). */
	readonly contextSize?: number;
	/**
	 * Number of layers to offload to GPU (`-ngl`). When unset, llama-server
	 * decides on its own (usually "all layers on GPU"). Set to `0` to force
	 * CPU-only inference — useful when running multiple llama-server
	 * instances concurrently on macOS where Metal working set is shared.
	 */
	readonly gpuLayers?: number;
	/**
	 * Unique id for this service instance. Detour spawns three concurrent
	 * llama-servers (`embedding`, `chat`, `companion`); without separate
	 * pid-files they all share `${ELIZA_STATE_DIR}/llama/server.pid`,
	 * and the next instance's reapOrphan() kills the previous one (the
	 * pid in the file IS a real llama-server, just not its own).
	 * Defaults to `"server"` to preserve the legacy path for the
	 * embedding server, which is the only consumer that existed when
	 * the pid-file scheme was introduced.
	 */
	readonly instanceId?: string;
}

export interface LlamaServerStatus {
	readonly running: boolean;
	readonly url: string | null;
	readonly modelPath: string | null;
	readonly pid: number | null;
	readonly startedAt: number | null;
	readonly lastError: string | null;
	readonly downloadProgress?: { downloadedBytes: number; totalBytes: number; percent: number } | null;
}

function resolveStateDir(): string {
	return (
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`)
	);
}

type HfModelRef = {
	user: string;
	repo: string;
	filePath: string;
	fileName: string;
};

type ByteReader = {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
};

/**
 * True if the file backing a hf:// ref is already on disk in the
 * default models dir (so a start would be instant, no download). The
 * tray's preset picker uses this to label presets "(downloaded)".
 * Non-hf:// refs are checked as absolute paths.
 */
export function isModelDownloaded(modelRef: string): boolean {
	try {
		if (!modelRef.startsWith("hf://")) {
			return existsSync(modelRef) && statSync(modelRef).size >= MIN_MODEL_BYTES;
		}
		const ref = parseHfModelRef(modelRef);
		const modelsDir = join(resolveStateDir(), "llama", "models");
		const localPath = join(modelsDir, ref.fileName);
		return existsSync(localPath) && statSync(localPath).size >= MIN_MODEL_BYTES;
	} catch {
		return false;
	}
}

function parseHfModelRef(modelRef: string): HfModelRef {
	const hfPath = modelRef.slice("hf://".length);
	const segments = hfPath.split("/");
	if (segments.length < 3) throw new Error(`invalid hf:// ref: ${modelRef}`);
	const filePath = segments.slice(2).join("/");
	return {
		user: segments[0]!,
		repo: segments[1]!,
		filePath,
		fileName: filePath.split("/").pop() ?? filePath,
	};
}

function resolveBundledBinaryDir(): string {
	// In the bundled .app: bun/index.js + bun/llama/llama-server.
	// In dev (running source via Bun): <repo-root>/build-assets/llama.
	const candidates: string[] = [];
	const here = dirname(new URL(import.meta.url).pathname);
	// <repo>/src/bun/core/llama → <repo>/build-assets/llama
	candidates.push(join(here, "..", "..", "..", "..", "build-assets", "llama"));
	// When running as `Detour-dev.app`, process.execPath points to the bundled
	// bun, and the binary lives next to it under Resources/app/bun/llama/.
	if (process.execPath) {
		candidates.push(join(dirname(process.execPath), "..", "Resources", "app", "bun", "llama"));
		candidates.push(join(dirname(process.execPath), "llama"));
	}
	for (const c of candidates) {
		if (existsSync(join(c, process.platform === "win32" ? "llama-server.exe" : "llama-server"))) {
			return c;
		}
	}
	throw new Error(
		`llama-server binary not found. Checked:\n${candidates.join("\n")}`,
	);
}

export class LlamaServerService {
	private process: ChildProcess | null = null;
	private port: number | null = null;
	private modelPath: string | null = null;
	private startPromise: Promise<{ url: string; modelPath: string } | null> | null = null;
	private lastError: string | null = null;
	private startedAt: number | null = null;
	private downloadProgress: { downloadedBytes: number; totalBytes: number; percent: number } | null = null;

	constructor(private readonly config: LlamaServerConfig = {}) {}

	status(): LlamaServerStatus {
		return {
			running: this.process !== null && this.process.exitCode === null,
			url: this.port ? `http://127.0.0.1:${this.port}` : null,
			modelPath: this.modelPath,
			pid: this.process?.pid ?? null,
			startedAt: this.startedAt,
			lastError: this.lastError,
			downloadProgress: this.downloadProgress,
		};
	}

	/** Starts the server if not running. Returns the base URL (no trailing slash). */
	async ensureRunning(): Promise<{ url: string; modelPath: string } | null> {
		if (this.process && this.port && this.process.exitCode === null) {
			return { url: `http://127.0.0.1:${this.port}`, modelPath: this.modelPath ?? "" };
		}
		if (!this.startPromise) {
			this.startPromise = this.start().finally(() => {
				this.startPromise = null;
			});
		}
		return this.startPromise;
	}

	private async start(): Promise<{ url: string; modelPath: string } | null> {
		try {
			// Reap any orphaned llama-server from a prior run (parent SIGKILL'd
			// or crashed before stop() ran). pidfile-based — safe across PID
			// reuse via comm-name verification.
			this.reapOrphan();
			const binaryDir = this.config.binaryDir ?? resolveBundledBinaryDir();
			const modelsDir = this.config.modelsDir ?? join(resolveStateDir(), "llama", "models");
			mkdirSync(modelsDir, { recursive: true });
			const modelRef = this.config.modelRef ?? process.env.LLAMA_EMBEDDING_MODEL ?? DEFAULT_MODEL_REF;
			const modelPath = await this.ensureModel(modelRef, modelsDir);
			this.modelPath = modelPath;
			const port = await this.pickPort();
			const binary = join(binaryDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
			const args = [
				"--model", modelPath,
				"--port", String(port),
				"--host", "127.0.0.1",
				"--ctx-size", String(this.config.contextSize ?? 512),
				"--log-disable",
			];
			if (this.config.embeddingOnly !== false) args.push("--embedding");
			if (this.config.threads) args.push("--threads", String(this.config.threads));
			if (this.config.gpuLayers !== undefined) {
				args.push("-ngl", String(this.config.gpuLayers));
			}

			const child = spawn(binary, args, {
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});
			this.process = child;
			this.port = port;
			this.startedAt = Date.now();
			this.lastError = null;
			if (child.pid !== undefined) {
				this.writePidFile(child.pid);
				// Watchdog: a detached shell process that polls our pid and
				// SIGKILLs llama when we die. The electrobun launcher masks
				// SIGTERM/SIGINT before they reach Bun's process listeners,
				// so JS-side cleanup hooks can't be relied on. The watchdog
				// runs in its own process group so it survives bun's death
				// and reliably reaps llama within ~1s.
				this.spawnWatchdog(process.pid, child.pid);
			}

			// Bubble useful errors but don't spam the parent's stdout.
			let stderrTail = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2048);
			});
			child.on("exit", (code, signal) => {
				if (code !== 0 && this.lastError === null) {
					this.lastError = `llama-server exited code=${code} signal=${signal}; stderr tail: ${stderrTail.slice(-512)}`;
				}
				this.process = null;
				this.port = null;
				this.startedAt = null;
				this.removePidFile();
			});
			child.on("error", (err) => {
				this.lastError = err.message;
			});

			await this.waitForReady(port);
			console.log(`[llama-server] listening at http://127.0.0.1:${port} model=${modelPath} pid=${child.pid}`);
			return { url: `http://127.0.0.1:${port}`, modelPath };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.lastError = msg;
			console.warn(`[llama-server] failed to start: ${msg}`);
			this.process?.kill();
			this.process = null;
			this.port = null;
			return null;
		}
	}

	stop(): void {
		const child = this.process;
		this.process = null;
		this.port = null;
		this.removePidFile();
		// SIGKILL — synchronous from our side and unignorable. The exit handler
		// in src/bun/index.ts has microseconds before process.exit() fires; a
		// graceful SIGTERM the child might miss isn't worth the orphan risk.
		try { child?.kill("SIGKILL"); } catch { /* already dead */ }
	}

	private pidFilePath(): string {
		const id = this.config.instanceId ?? "server";
		// Sanitize: allow only [A-Za-z0-9._-] so the id can't escape the
		// llama state dir even if it's user-supplied.
		const safe = id.replace(/[^A-Za-z0-9._-]/g, "_") || "server";
		return join(resolveStateDir(), "llama", `${safe}.pid`);
	}

	private writePidFile(pid: number): void {
		try {
			const path = this.pidFilePath();
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, String(pid), "utf8");
		} catch { /* best-effort */ }
	}

	private removePidFile(): void {
		try { unlinkSync(this.pidFilePath()); } catch { /* missing or already gone */ }
	}

	private spawnWatchdog(parentPid: number, childPid: number): void {
		try {
			// Poll once a second; when parent dies, SIGKILL llama and exit.
			const cmd = `while kill -0 ${parentPid} 2>/dev/null; do sleep 1; done; kill -9 ${childPid} 2>/dev/null`;
			spawn("sh", ["-c", cmd], {
				detached: true,
				stdio: "ignore",
			}).unref();
		} catch { /* best-effort */ }
	}

	private reapOrphan(): void {
		const path = this.pidFilePath();
		if (!existsSync(path)) return;
		try {
			const raw = readFileSync(path, "utf8").trim();
			const pid = Number.parseInt(raw, 10);
			if (!Number.isFinite(pid) || pid <= 1) {
				unlinkSync(path);
				return;
			}
			// Verify the pid is actually a llama-server (avoid PID-reuse killing
			// an unrelated process). Skip on win32 where `ps` isn't available.
			if (process.platform !== "win32") {
				const probe = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
				const comm = probe.stdout?.trim() ?? "";
				if (!comm.includes("llama-server")) {
					unlinkSync(path);
					return;
				}
			}
			try {
				process.kill(pid, "SIGKILL");
				console.log(`[llama-server] reaped orphaned pid=${pid} from previous run`);
			} catch { /* already dead */ }
			unlinkSync(path);
		} catch { /* best-effort */ }
	}

	private async pickPort(): Promise<number> {
		// Bind a temporary HTTP server on :0 to reserve a port, then close
		// it. The OS may reuse it before llama-server starts, but the
		// window is short (<10ms) and on collision llama-server will exit
		// loudly so the user sees lastError.
		const server = Bun.serve({ port: 0, fetch: () => new Response("noop") });
		const port = server.port;
		server.stop();
		if (typeof port !== "number") throw new Error("Bun.serve returned no port");
		return port;
	}

	private async waitForReady(port: number): Promise<void> {
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		const url = `http://127.0.0.1:${port}${HEALTH_PATH}`;
		// llama-server typically takes 1-3s to load a small model.
		while (Date.now() < deadline) {
			if (this.process && this.process.exitCode !== null) {
				throw new Error(`llama-server exited before ready (code=${this.process.exitCode}). Last error: ${this.lastError ?? "none"}`);
			}
			try {
				const res = await fetch(url);
				if (res.ok) return;
				// 503 = model still loading; keep polling.
			} catch {
				// connection refused / timeout — keep polling.
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`llama-server did not become ready within ${STARTUP_TIMEOUT_MS}ms. Last error: ${this.lastError ?? "none"}`);
	}

	/**
	 * Resolve a hf:// model reference to a local file path, downloading if
	 * needed. Idempotent: a present file ≥MIN_MODEL_BYTES is reused.
	 */
	private async ensureModel(modelRef: string, modelsDir: string): Promise<string> {
		if (!modelRef.startsWith("hf://")) {
			if (!existsSync(modelRef)) throw new Error(`model file not found: ${modelRef}`);
			return modelRef;
		}
		const ref = parseHfModelRef(modelRef);
		const localPath = join(modelsDir, ref.fileName);
		if (this.modelAlreadyPresent(localPath)) return localPath;
		return this.downloadModel(ref, localPath);
	}

	private modelAlreadyPresent(localPath: string): boolean {
		return existsSync(localPath) && statSync(localPath).size >= MIN_MODEL_BYTES;
	}

	private async downloadModel(ref: HfModelRef, localPath: string): Promise<string> {
		const downloadUrl = `https://huggingface.co/${ref.user}/${ref.repo}/resolve/main/${ref.filePath}`;
		console.log(`[llama-server] downloading model: ${downloadUrl}`);
		const res = await fetch(downloadUrl, { redirect: "follow" });
		if (!res.ok) {
			throw new Error(`HuggingFace returned HTTP ${res.status} for ${downloadUrl}`);
		}
		const totalBytes = Number(res.headers.get("content-length") ?? 0);
		this.downloadProgress = { downloadedBytes: 0, totalBytes, percent: 0 };
		const reader = res.body?.getReader();
		if (!reader) throw new Error("response body not readable");
		await this.writeModelDownload(reader, localPath, totalBytes);
		const final = statSync(localPath);
		if (final.size < MIN_MODEL_BYTES) {
			throw new Error(`download truncated (${final.size} bytes < ${MIN_MODEL_BYTES})`);
		}
		this.downloadProgress = { downloadedBytes: final.size, totalBytes: final.size, percent: 100 };
		console.log(`[llama-server] model ready: ${localPath} (${(final.size / 1024 / 1024).toFixed(1)} MB)`);
		return localPath;
	}

	private async writeModelDownload(
		reader: ByteReader,
		localPath: string,
		totalBytes: number,
	): Promise<void> {
		const writer = Bun.file(localPath).writer();
		let downloaded = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					writer.write(value);
					downloaded += value.byteLength;
					if (totalBytes > 0) {
						this.downloadProgress = {
							downloadedBytes: downloaded,
							totalBytes,
							percent: Math.floor((downloaded / totalBytes) * 100),
						};
					}
				}
			}
			await writer.end();
		} catch (err) {
			await writer.end();
			try { (await import("node:fs/promises")).unlink(localPath); } catch { /* best-effort */ }
			throw err;
		}
	}
}
