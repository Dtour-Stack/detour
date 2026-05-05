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

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
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

function resolveBundledBinaryDir(): string {
	// In the bundled .app: bun/index.js + bun/llama/llama-server.
	// In dev (running source via Bun): packages/tray/build-assets/llama, but
	// only when prepare:llama has run. We pick whichever exists.
	const candidates: string[] = [];
	const here = dirname(new URL(import.meta.url).pathname);
	candidates.push(join(here, "..", "..", "..", "tray", "build-assets", "llama"));
	candidates.push(join(here, "..", "..", "..", "..", "tray", "build-assets", "llama"));
	candidates.push(join(here, "llama"));
	candidates.push(join(here, "..", "llama"));
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
		`llama-server binary not found. Checked:\n${candidates.join("\n")}\nRun \`bun run prepare:llama\` in packages/tray to download it.`,
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

			const child = spawn(binary, args, {
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});
			this.process = child;
			this.port = port;
			this.startedAt = Date.now();
			this.lastError = null;

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
		this.process?.kill("SIGTERM");
		this.process = null;
		this.port = null;
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
			// Treat as direct file path.
			if (!existsSync(modelRef)) throw new Error(`model file not found: ${modelRef}`);
			return modelRef;
		}
		const hfPath = modelRef.slice("hf://".length);
		const segments = hfPath.split("/");
		if (segments.length < 3) throw new Error(`invalid hf:// ref: ${modelRef}`);
		const user = segments[0];
		const repo = segments[1];
		const filePath = segments.slice(2).join("/");
		const fileName = filePath.split("/").pop() ?? filePath;
		const localPath = join(modelsDir, fileName);
		if (existsSync(localPath)) {
			const size = statSync(localPath).size;
			if (size >= MIN_MODEL_BYTES) return localPath;
		}
		const downloadUrl = `https://huggingface.co/${user}/${repo}/resolve/main/${filePath}`;
		console.log(`[llama-server] downloading model: ${downloadUrl}`);
		const res = await fetch(downloadUrl, { redirect: "follow" });
		if (!res.ok) {
			throw new Error(`HuggingFace returned HTTP ${res.status} for ${downloadUrl}`);
		}
		const totalBytes = Number(res.headers.get("content-length") ?? 0);
		this.downloadProgress = { downloadedBytes: 0, totalBytes, percent: 0 };
		const reader = res.body?.getReader();
		if (!reader) throw new Error("response body not readable");
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
		const final = statSync(localPath);
		if (final.size < MIN_MODEL_BYTES) {
			throw new Error(`download truncated (${final.size} bytes < ${MIN_MODEL_BYTES})`);
		}
		this.downloadProgress = { downloadedBytes: final.size, totalBytes: final.size, percent: 100 };
		console.log(`[llama-server] model ready: ${localPath} (${(final.size / 1024 / 1024).toFixed(1)} MB)`);
		return localPath;
	}
}
