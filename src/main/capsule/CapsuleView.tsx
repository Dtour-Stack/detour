import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onChatComplete, onChatDelta, onChatError } from "../rpc-listeners/chat";
import { rpc } from "../rpc";

type CaptureKind = "text" | "image" | "binary";
type CaptureState = "reading" | "ready" | "error";
type CapsulePhase = "ready" | "listening" | "thinking" | "receiving" | "speaking" | "notified" | "error";
type TimelineTone = "active" | "done" | "error" | "neutral";

type CaptureFile = {
	id: string;
	name: string;
	type: string;
	size: number;
	kind: CaptureKind;
	state: CaptureState;
	path?: string;
	excerpt?: string;
	fragmentCount?: number;
	error?: string;
};

type TimelineItem = {
	id: string;
	label: string;
	detail?: string;
	tone: TimelineTone;
};

type SpeechRecognitionAlternativeShape = {
	transcript: string;
};

type SpeechRecognitionResultShape = {
	isFinal: boolean;
	length: number;
	[index: number]: SpeechRecognitionAlternativeShape;
};

type SpeechRecognitionResultListShape = {
	length: number;
	[index: number]: SpeechRecognitionResultShape;
};

type SpeechRecognitionEventShape = Event & {
	resultIndex: number;
	results: SpeechRecognitionResultListShape;
};

type SpeechRecognitionErrorEventShape = Event & {
	error?: string;
	message?: string;
};

type SpeechRecognitionInstanceShape = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechRecognitionEventShape) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEventShape) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
};

type SpeechRecognitionConstructorShape = new () => SpeechRecognitionInstanceShape;

const CONV_ID = "capsule";
const MAX_EXCERPT_CHARS = 24_000;
const TEXT_MIMES = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/html",
	"text/xml",
	"text/x-yaml",
	"application/json",
	"application/xml",
	"application/yaml",
]);

const PHASE_LABEL: Record<CapsulePhase, string> = {
	ready: "ready",
	listening: "listening",
	thinking: "thinking",
	receiving: "receiving",
	speaking: "speaking",
	notified: "notified",
	error: "needs attention",
};

function fileKind(file: File): CaptureKind {
	if (file.type.startsWith("image/")) return "image";
	if (TEXT_MIMES.has(file.type) || file.type.startsWith("text/")) return "text";
	if (/\.(md|markdown|txt|json|yaml|yml|xml|html|csv|log|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|scss)$/i.test(file.name)) return "text";
	return "binary";
}

function browserFilePath(file: File): string | undefined {
	const withPath = file as File & { path?: string };
	return typeof withPath.path === "string" && withPath.path.trim() ? withPath.path : undefined;
}

function readAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsText(file);
	});
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function extractUrls(text: string): string[] {
	return Array.from(new Set(text.match(/\bhttps?:\/\/[^\s<>"')]+/g) ?? []));
}

function compact(text: string, max = 220): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function filenameLabel(name: string, max = 24): string {
	return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructorShape | null {
	if (typeof window === "undefined") return null;
	const scoped = window as Window & {
		SpeechRecognition?: SpeechRecognitionConstructorShape;
		webkitSpeechRecognition?: SpeechRecognitionConstructorShape;
	};
	return scoped.SpeechRecognition ?? scoped.webkitSpeechRecognition ?? null;
}

function buildPrompt(text: string, files: CaptureFile[]): string {
	const sections: string[] = ["Source: Detour floating capsule."];
	const trimmed = text.trim();
	if (trimmed) sections.push(`Request:\n${trimmed}`);
	const urls = extractUrls(trimmed);
	if (urls.length > 0) sections.push(`URLs:\n${urls.map((url) => `- ${url}`).join("\n")}`);
	if (files.length > 0) {
		const summaries = files.map((file) => {
			const parts = [
				`- ${file.name}`,
				`kind=${file.kind}`,
				`type=${file.type || "unknown"}`,
				`size=${formatBytes(file.size)}`,
			];
			if (file.path) parts.push(`path=${file.path}`);
			if (file.fragmentCount !== undefined) parts.push(`pensieveFragments=${file.fragmentCount}`);
			if (file.error) parts.push(`note=${file.error}`);
			return parts.join(" ");
		});
		sections.push(`Captured files:\n${summaries.join("\n")}`);
		const excerpts = files
			.filter((file) => file.excerpt)
			.map((file) => `--- ${file.name} ---\n${file.excerpt}`);
		if (excerpts.length > 0) sections.push(`Text excerpts:\n${excerpts.join("\n\n")}`);
	}
	sections.push("Use the captured context directly. If a local path is present, inspect it before asking me to resend the artifact.");
	return sections.join("\n\n");
}

function Icon({ name }: { name: "file" | "mic" | "voice" | "send" | "x" }) {
	const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" className="capsule-icon">
			{name === "file" && <path {...common} d="M7 3h7l4 4v14H7zM14 3v5h5M9.5 13h5M9.5 17h3" />}
			{name === "mic" && <path {...common} d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6" />}
			{name === "voice" && <path {...common} d="M4 10v4h3l4 4V6L7 10H4ZM15 9.5a4 4 0 0 1 0 5M18 7a8 8 0 0 1 0 10" />}
			{name === "send" && <path {...common} d="M4 12 20 4l-5 16-3-7-8-1ZM12 13l8-9" />}
			{name === "x" && <path {...common} d="M7 7l10 10M17 7 7 17" />}
		</svg>
	);
}

export function CapsuleView() {
	const recognitionCtor = useMemo(getSpeechRecognitionConstructor, []);
	const [text, setText] = useState("");
	const [files, setFiles] = useState<CaptureFile[]>([]);
	const [assistant, setAssistant] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("ready");
	const [phase, setPhase] = useState<CapsulePhase>("ready");
	const [dragging, setDragging] = useState(false);
	const [interim, setInterim] = useState("");
	const [listening, setListening] = useState(false);
	const [voiceOutput, setVoiceOutput] = useState(() => localStorage.getItem("detour.capsule.voiceOutput") === "1");
	const [timeline, setTimeline] = useState<TimelineItem[]>([
		{ id: "ready", label: "Capsule ready", detail: "Drop text, links, files, images, or voice", tone: "neutral" },
	]);
	const lastPointer = useRef<{ x: number; y: number } | null>(null);
	const recognition = useRef<SpeechRecognitionInstanceShape | null>(null);
	const listeningRef = useRef(false);
	const assistantRef = useRef("");
	const activeTraceRef = useRef<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const timelineSeq = useRef(0);
	const hasPendingFiles = files.some((file) => file.state === "reading");
	const detectedUrls = useMemo(() => extractUrls(text), [text]);

	const pushTimeline = useCallback((label: string, detail: string | undefined, tone: TimelineTone) => {
		timelineSeq.current += 1;
		const item: TimelineItem = {
			id: `${Date.now()}:${timelineSeq.current}`,
			label,
			...(detail ? { detail } : {}),
			tone,
		};
		setTimeline((current) => [item, ...current].slice(0, 5));
	}, []);

	useEffect(() => {
		listeningRef.current = listening;
	}, [listening]);

	useEffect(() => {
		localStorage.setItem("detour.capsule.voiceOutput", voiceOutput ? "1" : "0");
		if (!voiceOutput) {
			window.speechSynthesis?.cancel();
			setPhase((current) => current === "speaking" ? "ready" : current);
			setStatus((current) => current === "speaking" ? "ready" : current);
		}
	}, [voiceOutput]);

	const stopListening = useCallback(() => {
		recognition.current?.stop();
		recognition.current = null;
		setListening(false);
		setInterim("");
		setPhase("ready");
		setStatus("ready");
	}, []);

	const startListening = useCallback(() => {
		if (!recognitionCtor || recognition.current) return;
		const next = new recognitionCtor();
		next.continuous = true;
		next.interimResults = true;
		next.lang = navigator.language || "en-US";
		next.onresult = (event) => {
			let finalText = "";
			let interimText = "";
			for (let index = event.resultIndex; index < event.results.length; index += 1) {
				const result = event.results[index];
				const transcript = result?.[0]?.transcript ?? "";
				if (result?.isFinal) finalText += transcript;
				else interimText += transcript;
			}
			if (finalText.trim()) {
				setText((current) => `${current}${current.trim() ? " " : ""}${finalText.trim()}`);
			}
			setInterim(interimText.trim());
		};
		next.onerror = (event) => {
			const message = event.error ?? event.message ?? "voice input failed";
			setPhase("error");
			setStatus(message);
			pushTimeline("Voice input stopped", message, "error");
		};
		next.onend = () => {
			recognition.current = null;
			setListening(false);
			setInterim("");
			setPhase("ready");
			setStatus("ready");
		};
		recognition.current = next;
		next.start();
		setListening(true);
		setPhase("listening");
		setStatus("listening");
		pushTimeline("Listening", "Voice input is on", "active");
	}, [pushTimeline, recognitionCtor]);

	const speak = useCallback((message: string): boolean => {
		if (!voiceOutput || !message.trim()) return false;
		if (!window.speechSynthesis) return false;
		const wasListening = listeningRef.current;
		if (wasListening) stopListening();
		const utterance = new SpeechSynthesisUtterance(compact(message, 700));
		utterance.rate = 0.98;
		utterance.pitch = 1.02;
		utterance.onstart = () => {
			setPhase("speaking");
			setStatus("speaking");
			pushTimeline("Speaking report", compact(message, 120), "active");
		};
		utterance.onend = () => {
			pushTimeline("Spoken report finished", undefined, "done");
			setPhase("ready");
			setStatus("ready");
			if (wasListening) window.setTimeout(startListening, 250);
		};
		utterance.onerror = () => {
			setPhase("error");
			setStatus("voice output failed");
			pushTimeline("Voice output failed", undefined, "error");
		};
		window.speechSynthesis.cancel();
		window.speechSynthesis.speak(utterance);
		return true;
	}, [pushTimeline, startListening, stopListening, voiceOutput]);

	useEffect(() => {
		const offDelta = onChatDelta((payload) => {
			if (payload.convId !== CONV_ID) return;
			if (activeTraceRef.current && payload.traceId !== activeTraceRef.current) return;
			if (!activeTraceRef.current && payload.traceId) activeTraceRef.current = payload.traceId;
			assistantRef.current += payload.delta;
			setAssistant(assistantRef.current);
			setPhase("receiving");
			setStatus("receiving");
		});
		const offComplete = onChatComplete((payload) => {
			if (payload.convId !== CONV_ID) return;
			if (activeTraceRef.current && payload.traceId !== activeTraceRef.current) return;
			if (!activeTraceRef.current && payload.traceId) activeTraceRef.current = payload.traceId;
			setBusy(false);
			const message = assistantRef.current.trim();
			if (!message) {
				setPhase("ready");
				setStatus("ready");
				return;
			}
			pushTimeline("Agent report ready", compact(message, 140), "done");
			if (!speak(message)) {
				setPhase("notified");
				setStatus("notified");
				pushTimeline("Notification sent", compact(message, 120), "done");
				void rpc.request.capsuleNotify({ title: "Detour", body: compact(message, 180) });
			}
		});
		const offError = onChatError((payload) => {
			if (payload.convId !== CONV_ID) return;
			if (activeTraceRef.current && payload.traceId !== activeTraceRef.current) return;
			if (!activeTraceRef.current && payload.traceId) activeTraceRef.current = payload.traceId;
			setBusy(false);
			setPhase("error");
			setStatus(payload.message);
			pushTimeline("Agent run failed", payload.message, "error");
			void rpc.request.capsuleNotify({ title: "Detour error", body: compact(payload.message, 180) });
		});
		return () => {
			offDelta();
			offComplete();
			offError();
		};
	}, [pushTimeline, speak]);

	useEffect(() => {
		if (!dragging) return;
		const onMove = (event: PointerEvent) => {
			if (!lastPointer.current) return;
			const dx = event.screenX - lastPointer.current.x;
			const dy = event.screenY - lastPointer.current.y;
			lastPointer.current = { x: event.screenX, y: event.screenY };
			rpc.send.capsuleWindowDrag({ dx, dy });
		};
		const onUp = () => {
			lastPointer.current = null;
			setDragging(false);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [dragging]);

	const addFile = useCallback(async (file: File) => {
		const id = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
		const kind = fileKind(file);
		const base: CaptureFile = {
			id,
			name: file.name,
			type: file.type,
			size: file.size,
			kind,
			state: kind === "text" ? "reading" : "ready",
			...(browserFilePath(file) ? { path: browserFilePath(file) } : {}),
		};
		setFiles((current) => [...current, base]);
		pushTimeline("Captured file", `${filenameLabel(file.name)} · ${kind} · ${formatBytes(file.size)}`, kind === "text" ? "active" : "done");
		if (kind !== "text") return;
		try {
			const content = await readAsText(file);
			const excerpt = content.slice(0, MAX_EXCERPT_CHARS);
			let fragmentCount: number | undefined;
			try {
				const ingested = await rpc.request.pensieveKnowledgeIngest({
					filename: file.name,
					content,
					contentType: file.type || "text/plain",
					metadata: { source: "capsule" },
				});
				fragmentCount = ingested.fragmentCount;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setFiles((current) => current.map((item) => item.id === id ? {
					...item,
					state: "ready",
					excerpt,
					error: message,
				} : item));
				pushTimeline("Kept text excerpt", `${filenameLabel(file.name)} · ${compact(message, 80)}`, "error");
				return;
			}
			setFiles((current) => current.map((item) => item.id === id ? { ...item, state: "ready", excerpt, fragmentCount } : item));
			pushTimeline("Indexed text", `${filenameLabel(file.name)} · ${fragmentCount} fragments`, "done");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setFiles((current) => current.map((item) => item.id === id ? {
				...item,
				state: "error",
				error: message,
			} : item));
			pushTimeline("File read failed", `${filenameLabel(file.name)} · ${compact(message, 80)}`, "error");
		}
	}, [pushTimeline]);

	const addFiles = useCallback((list: FileList | File[]) => {
		for (const file of Array.from(list)) void addFile(file);
	}, [addFile]);

	const submit = useCallback(async () => {
		if (busy || hasPendingFiles) return;
		const prompt = buildPrompt(text, files);
		if (!text.trim() && files.length === 0) return;
		assistantRef.current = "";
		activeTraceRef.current = null;
		setAssistant("");
		setBusy(true);
		setPhase("thinking");
		setStatus("sent");
		pushTimeline("Sent to Detour", `${files.length} file${files.length === 1 ? "" : "s"} · ${detectedUrls.length} URL${detectedUrls.length === 1 ? "" : "s"}`, "active");
		try {
			const response = await rpc.request.chatSend({ convId: CONV_ID, text: prompt });
			activeTraceRef.current = response.traceId;
			setText("");
			setFiles([]);
			pushTimeline("Agent run started", response.traceId, "active");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setBusy(false);
			setPhase("error");
			setStatus(message);
			pushTimeline("Send failed", message, "error");
			void rpc.request.capsuleNotify({ title: "Detour error", body: compact(message, 180) });
		}
	}, [busy, detectedUrls.length, files, hasPendingFiles, pushTimeline, text]);

	const removeFile = useCallback((id: string) => {
		setFiles((current) => current.filter((file) => file.id !== id));
	}, []);

	const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			void submit();
		}
	}, [submit]);

	const statusLabel = phase === "error" ? compact(status, 42) : PHASE_LABEL[phase];

	return (
		<div
			className={`capsule${dragging ? " dragging" : ""}`}
			onDragOver={(event) => event.preventDefault()}
			onDrop={(event) => {
				event.preventDefault();
				if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
			}}
		>
			<style>{CAPSULE_CSS}</style>
			<div
				className="capsule-top"
				onPointerDown={(event) => {
					lastPointer.current = { x: event.screenX, y: event.screenY };
					setDragging(true);
				}}
			>
				<div className="capsule-brand">Detour</div>
				<div className={`capsule-status ${phase}`}>{statusLabel}</div>
				<button
					type="button"
					className="capsule-close"
					onClick={() => void rpc.request.capsuleHide({})}
					title="Close capsule"
					aria-label="Close capsule"
					onPointerDown={(event) => event.stopPropagation()}
				>
					<Icon name="x" />
				</button>
			</div>
			<div className="capsule-main">
				<textarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Ask, paste a URL, drop files"
					spellCheck
					autoFocus
				/>
				<div className="capsule-actions">
					<input
						ref={fileInputRef}
						type="file"
						multiple
						onChange={(event) => {
							if (event.target.files) addFiles(event.target.files);
							event.currentTarget.value = "";
						}}
					/>
					<button type="button" onClick={() => fileInputRef.current?.click()} title="Attach files" aria-label="Attach files">
						<Icon name="file" />
					</button>
					<button
						type="button"
						onClick={() => listening ? stopListening() : startListening()}
						disabled={!recognitionCtor}
						className={listening ? "active" : ""}
						title={recognitionCtor ? "Toggle listening" : "Voice input unavailable"}
						aria-label="Toggle listening"
					>
						<Icon name="mic" />
					</button>
					<button
						type="button"
						onClick={() => setVoiceOutput((current) => !current)}
						className={voiceOutput ? "active" : ""}
						title={voiceOutput ? "Voice reports on" : "Notifications on"}
						aria-label="Toggle voice reports"
					>
						<Icon name="voice" />
					</button>
					<button
						type="button"
						className="send"
						onClick={() => void submit()}
						disabled={busy || hasPendingFiles || (!text.trim() && files.length === 0)}
						title="Send"
						aria-label="Send"
					>
						<Icon name="send" />
					</button>
				</div>
			</div>
			{interim && <div className="capsule-interim">{interim}</div>}
			{(detectedUrls.length > 0 || files.length > 0) && (
				<div className="capsule-context" aria-label="Captured context">
					{detectedUrls.slice(0, 3).map((url) => (
						<div key={url} className="capsule-chip url" title={url}>
							<span>URL</span>
							<small>{compact(url.replace(/^https?:\/\//, ""), 36)}</small>
						</div>
					))}
					{files.map((file) => (
						<div key={file.id} className={`capsule-chip file ${file.state}`} title={file.error ?? file.name}>
							<span>{file.kind}</span>
							<small>{file.state === "reading" ? "reading" : file.fragmentCount !== undefined ? `${file.fragmentCount} frags` : filenameLabel(file.name, 28)}</small>
							<button type="button" onClick={() => removeFile(file.id)} aria-label={`Remove ${file.name}`}>
								<Icon name="x" />
							</button>
						</div>
					))}
				</div>
			)}
			{timeline.length > 0 && (
				<div className="capsule-timeline" aria-label="Run timeline">
					{timeline.slice(0, 4).map((item) => (
						<div key={item.id} className={`capsule-step ${item.tone}`}>
							<span className="capsule-step-dot" />
							<div>
								<span>{item.label}</span>
								{item.detail && <small>{item.detail}</small>}
							</div>
						</div>
					))}
				</div>
			)}
			{(assistant || busy) && (
				<div className="capsule-reply">
					{assistant ? compact(assistant, 340) : "…"}
				</div>
			)}
		</div>
	);
}

const CAPSULE_CSS = `
:root { color-scheme: dark light; }
html, body, #root {
	margin: 0;
	width: 100%;
	height: 100%;
	overflow: hidden;
	background: transparent;
}
* { box-sizing: border-box; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
}
.capsule {
	width: 620px;
	height: 280px;
	padding: 10px;
	border-radius: 18px;
	background: rgba(24, 24, 27, 0.88);
	color: #f5f5f7;
	border: 1px solid rgba(255, 255, 255, 0.14);
	box-shadow: 0 18px 60px rgba(0, 0, 0, 0.36);
	backdrop-filter: saturate(180%) blur(24px);
	-webkit-backdrop-filter: saturate(180%) blur(24px);
}
.capsule-top {
	height: 26px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 0 4px 7px;
	cursor: grab;
	user-select: none;
	-webkit-user-select: none;
}
.capsule.dragging .capsule-top {
	cursor: grabbing;
}
.capsule-close {
	width: 22px;
	height: 22px;
	flex-shrink: 0;
	border: 0;
	outline: 0;
	padding: 0;
	background: rgba(255, 255, 255, 0.08);
	border-radius: 6px;
	cursor: pointer;
	color: rgba(245, 245, 247, 0.52);
	display: inline-flex;
	align-items: center;
	justify-content: center;
}
.capsule-close:hover {
	background: rgba(255, 69, 58, 0.24);
	color: #ff453a;
}
.capsule-close .capsule-icon {
	width: 14px;
	height: 14px;
}
.capsule-brand {
	font-size: 12px;
	font-weight: 650;
	color: rgba(245, 245, 247, 0.86);
}
.capsule-status {
	max-width: 260px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 11px;
	color: rgba(245, 245, 247, 0.5);
}
.capsule-status.listening,
.capsule-status.speaking {
	color: #30d158;
}
.capsule-status.thinking,
.capsule-status.receiving {
	color: #64d2ff;
}
.capsule-status.notified {
	color: #ffd60a;
}
.capsule-status.error {
	color: #ff453a;
}
.capsule-main {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 8px;
	align-items: stretch;
}
.capsule textarea {
	width: 100%;
	min-height: 82px;
	max-height: 82px;
	resize: none;
	border: 0;
	outline: 0;
	border-radius: 13px;
	padding: 12px 13px;
	background: rgba(255, 255, 255, 0.08);
	color: #fff;
	font-size: 15px;
	line-height: 1.35;
	box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.capsule textarea::placeholder {
	color: rgba(245, 245, 247, 0.42);
}
.capsule-actions {
	display: grid;
	grid-template-columns: repeat(2, 34px);
	gap: 6px;
}
.capsule-actions input {
	display: none;
}
.capsule-actions button,
.capsule-chip button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border: 0;
	outline: 0;
	color: rgba(245, 245, 247, 0.72);
	background: rgba(255, 255, 255, 0.08);
	cursor: pointer;
}
.capsule-actions button {
	width: 34px;
	height: 34px;
	border-radius: 10px;
}
.capsule-actions button:hover:not(:disabled),
.capsule-chip button:hover {
	background: rgba(255, 255, 255, 0.14);
	color: #fff;
}
.capsule-actions button.active {
	background: rgba(10, 132, 255, 0.28);
	color: #64d2ff;
}
.capsule-actions button.send {
	background: #0a84ff;
	color: white;
}
.capsule-actions button:disabled {
	opacity: 0.38;
	cursor: not-allowed;
}
.capsule-icon {
	width: 18px;
	height: 18px;
}
.capsule-interim {
	margin: 8px 2px 0;
	font-size: 12px;
	color: rgba(245, 245, 247, 0.48);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.capsule-context {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	margin-top: 8px;
	max-height: 42px;
	overflow: hidden;
}
.capsule-chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	max-width: 196px;
	min-width: 0;
	padding: 5px 6px 5px 9px;
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.08);
	color: rgba(245, 245, 247, 0.88);
	font-size: 11px;
}
.capsule-chip.url {
	background: rgba(10, 132, 255, 0.16);
}
.capsule-chip.error {
	background: rgba(255, 69, 58, 0.18);
}
.capsule-chip span {
	flex: 0 0 auto;
	color: rgba(245, 245, 247, 0.52);
	font-size: 10px;
	text-transform: uppercase;
}
.capsule-chip small {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: rgba(245, 245, 247, 0.82);
	font-size: 10px;
}
.capsule-chip button {
	flex: 0 0 auto;
	width: 18px;
	height: 18px;
	border-radius: 999px;
	padding: 0;
}
.capsule-chip .capsule-icon {
	width: 12px;
	height: 12px;
}
.capsule-timeline {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 6px 8px;
	margin-top: 8px;
	max-height: 72px;
	overflow: hidden;
}
.capsule-step {
	display: grid;
	grid-template-columns: 8px minmax(0, 1fr);
	gap: 7px;
	align-items: start;
	min-width: 0;
	padding: 6px 7px;
	border-radius: 10px;
	background: rgba(255, 255, 255, 0.055);
}
.capsule-step-dot {
	width: 7px;
	height: 7px;
	margin-top: 4px;
	border-radius: 999px;
	background: rgba(245, 245, 247, 0.34);
}
.capsule-step.active .capsule-step-dot {
	background: #64d2ff;
}
.capsule-step.done .capsule-step-dot {
	background: #30d158;
}
.capsule-step.error .capsule-step-dot {
	background: #ff453a;
}
.capsule-step span {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: rgba(245, 245, 247, 0.86);
	font-size: 11px;
	line-height: 1.25;
}
.capsule-step small {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: rgba(245, 245, 247, 0.46);
	font-size: 10px;
	line-height: 1.25;
}
.capsule-reply {
	margin-top: 9px;
	padding: 8px 11px;
	min-height: 34px;
	max-height: 48px;
	overflow: hidden;
	border-radius: 12px;
	background: rgba(0, 0, 0, 0.18);
	color: rgba(245, 245, 247, 0.84);
	font-size: 12px;
	line-height: 1.35;
}
@media (prefers-color-scheme: light) {
	.capsule {
		background: rgba(246, 246, 248, 0.9);
		color: #1d1d1f;
		border-color: rgba(0, 0, 0, 0.1);
		box-shadow: 0 18px 60px rgba(0, 0, 0, 0.22);
	}
	.capsule-brand,
	.capsule textarea,
	.capsule-chip,
	.capsule-step span {
		color: #1d1d1f;
	}
	.capsule-status,
	.capsule-interim,
	.capsule-chip span,
	.capsule-step small {
		color: rgba(29, 29, 31, 0.52);
	}
	.capsule-chip small {
		color: rgba(29, 29, 31, 0.82);
	}
	.capsule textarea,
	.capsule-actions button,
	.capsule-chip,
	.capsule-step,
	.capsule-reply {
		background: rgba(0, 0, 0, 0.06);
	}
	.capsule textarea::placeholder {
		color: rgba(29, 29, 31, 0.42);
	}
	.capsule-reply {
		color: rgba(29, 29, 31, 0.8);
	}
}
`;
