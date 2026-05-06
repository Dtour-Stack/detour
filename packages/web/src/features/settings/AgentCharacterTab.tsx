import { useEffect, useMemo, useState } from "react";
import type { AgentCharacterConfig, AgentCharacterMessageExample } from "@detour/shared";
import type { WebClient } from "../../api/client";

function lines(value: string[]): string {
	return value.join("\n");
}

function splitLines(value: string): string[] {
	return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseExamples(value: string): AgentCharacterMessageExample[][] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed)) throw new Error("messageExamples must be a JSON array");
	for (const group of parsed) {
		if (!Array.isArray(group)) throw new Error("each messageExamples entry must be a conversation array");
		for (const message of group) {
			if (!message || typeof message !== "object" || Array.isArray(message)) {
				throw new Error("each message example must be an object");
			}
			const obj = message as Record<string, unknown>;
			const content = obj.content as Record<string, unknown> | undefined;
			if (typeof obj.name !== "string" || !content || typeof content.text !== "string") {
				throw new Error("each message example needs name and content.text");
			}
		}
	}
	return parsed as AgentCharacterMessageExample[][];
}

export function AgentCharacterTab({ client }: { client: WebClient }) {
	const [cfg, setCfg] = useState<AgentCharacterConfig | null>(null);
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		void client.getAgentCharacter().then((character) => {
			setCfg(character);
			setDraft({
				name: character.name,
				username: character.username,
				system: character.system,
				bio: lines(character.bio),
				lore: lines(character.lore),
				adjectives: lines(character.adjectives),
				topics: lines(character.topics),
				styleAll: lines(character.style.all),
				styleChat: lines(character.style.chat),
				stylePost: lines(character.style.post),
				postExamples: lines(character.postExamples),
				messageExamples: JSON.stringify(character.messageExamples, null, 2),
			});
		});
	}, [client]);

	const nextCharacter = useMemo<AgentCharacterConfig | null>(() => {
		if (!cfg) return null;
		return {
			name: draft.name ?? cfg.name,
			username: draft.username ?? cfg.username,
			system: draft.system ?? cfg.system,
			bio: splitLines(draft.bio ?? ""),
			lore: splitLines(draft.lore ?? ""),
			adjectives: splitLines(draft.adjectives ?? ""),
			topics: splitLines(draft.topics ?? ""),
			style: {
				all: splitLines(draft.styleAll ?? ""),
				chat: splitLines(draft.styleChat ?? ""),
				post: splitLines(draft.stylePost ?? ""),
			},
			postExamples: splitLines(draft.postExamples ?? ""),
			messageExamples: cfg.messageExamples,
		};
	}, [cfg, draft]);

	async function save() {
		if (!nextCharacter) return;
		setSaving(true);
		setError(null);
		try {
			const messageExamples = parseExamples(draft.messageExamples ?? "[]");
			const payload = { ...nextCharacter, messageExamples };
			await client.setAgentCharacter(payload);
			setCfg(payload);
			setSavedAt(Date.now());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	function set(key: string, value: string) {
		setDraft((current) => ({ ...current, [key]: value }));
	}

	if (!cfg) return <div className="hint">Loading...</div>;

	return (
		<div className="agent-character-settings">
			<div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
				<div>
					<h3 style={{ margin: "0 0 4px" }}>Agent character</h3>
					<p className="hint" style={{ margin: 0 }}>
						Customize the elizaOS character fields that shape the runtime persona: system prompt, bio, lore, topics, style, posts, and examples.
					</p>
				</div>
				<button type="button" className="btn small" disabled={saving} onClick={save}>
					{saving ? "Saving..." : "Save and reload"}
				</button>
			</div>

			{error && <div className="banner error" style={{ marginBottom: 10 }}>{error}</div>}
			{!error && savedAt && <div className="banner success" style={{ marginBottom: 10 }}>Saved. Runtime reloaded.</div>}

			<div className="card">
				<div className="agent-character-grid">
					<div>
						<label>Name</label>
						<input type="text" value={draft.name ?? ""} onChange={(e) => set("name", e.target.value)} />
					</div>
					<div>
						<label>Username</label>
						<input type="text" value={draft.username ?? ""} onChange={(e) => set("username", e.target.value)} />
					</div>
				</div>
			</div>

			<div className="card">
				<label>System prompt</label>
				<textarea
					className="pensieve-textarea agent-character-system"
					value={draft.system ?? ""}
					onChange={(e) => set("system", e.target.value)}
				/>
			</div>

			<div className="agent-character-grid">
				<div className="card">
					<label>Bio</label>
					<textarea className="pensieve-textarea" rows={8} value={draft.bio ?? ""} onChange={(e) => set("bio", e.target.value)} />
				</div>
				<div className="card">
					<label>Lore</label>
					<textarea className="pensieve-textarea" rows={8} value={draft.lore ?? ""} onChange={(e) => set("lore", e.target.value)} />
				</div>
				<div className="card">
					<label>Topics</label>
					<textarea className="pensieve-textarea" rows={8} value={draft.topics ?? ""} onChange={(e) => set("topics", e.target.value)} />
				</div>
				<div className="card">
					<label>Adjectives</label>
					<textarea className="pensieve-textarea" rows={8} value={draft.adjectives ?? ""} onChange={(e) => set("adjectives", e.target.value)} />
				</div>
			</div>

			<div className="agent-character-grid">
				<div className="card">
					<label>Style: all</label>
					<textarea className="pensieve-textarea" rows={7} value={draft.styleAll ?? ""} onChange={(e) => set("styleAll", e.target.value)} />
				</div>
				<div className="card">
					<label>Style: chat</label>
					<textarea className="pensieve-textarea" rows={7} value={draft.styleChat ?? ""} onChange={(e) => set("styleChat", e.target.value)} />
				</div>
				<div className="card">
					<label>Style: post</label>
					<textarea className="pensieve-textarea" rows={7} value={draft.stylePost ?? ""} onChange={(e) => set("stylePost", e.target.value)} />
				</div>
			</div>

			<div className="card">
				<label>Post examples</label>
				<textarea className="pensieve-textarea" rows={8} value={draft.postExamples ?? ""} onChange={(e) => set("postExamples", e.target.value)} />
			</div>

			<div className="card">
				<label>Message examples JSON</label>
				<textarea
					className="pensieve-textarea agent-character-examples"
					value={draft.messageExamples ?? ""}
					onChange={(e) => set("messageExamples", e.target.value)}
				/>
			</div>
		</div>
	);
}
