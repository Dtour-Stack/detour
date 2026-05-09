import { useEffect, useState } from "react";
import type { AgentCharacterConfig, AgentCharacterMessageExample } from "../../shared/index";
import type { WebClient } from "../api/client";

function lines(value: string[]): string {
	return value.join("\n");
}

function splitLines(value: string): string[] {
	return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseExamples(value: string): AgentCharacterMessageExample[][] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("messageExamples must be valid JSON");
	}
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

function draftFromCharacter(character: AgentCharacterConfig): Record<string, string> {
	return {
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
	};
}

function draftCharacter(
	cfg: AgentCharacterConfig,
	draft: Record<string, string>,
	messageExamples: AgentCharacterMessageExample[][],
): AgentCharacterConfig {
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
		messageExamples,
	};
}

type DraftSetter = (key: string, value: string) => void;

function CharacterHeader({ saving, onSave }: { saving: boolean; onSave: () => void }) {
	return (
		<div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
			<div>
				<h3 style={{ margin: "0 0 4px" }}>Agent character</h3>
				<p className="hint" style={{ margin: 0 }}>
					Customize the elizaOS character fields that shape the runtime persona: system prompt, bio, lore, topics, style, posts, and examples.
				</p>
			</div>
			<button type="button" className="btn small" disabled={saving} onClick={onSave}>
				{saving ? "Saving..." : "Save and reload"}
			</button>
		</div>
	);
}

function BasicFields({ draft, set }: { draft: Record<string, string>; set: DraftSetter }) {
	return (
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
	);
}

function SystemField({ draft, set }: { draft: Record<string, string>; set: DraftSetter }) {
	return (
		<div className="card">
			<label>System prompt</label>
			<textarea
				className="pensieve-textarea agent-character-system"
				value={draft.system ?? ""}
				onChange={(e) => set("system", e.target.value)}
			/>
		</div>
	);
}

function TextAreaCard({
	field,
	label,
	rows,
	draft,
	set,
}: {
	field: string;
	label: string;
	rows: number;
	draft: Record<string, string>;
	set: DraftSetter;
}) {
	return (
		<div className="card">
			<label>{label}</label>
			<textarea className="pensieve-textarea" rows={rows} value={draft[field] ?? ""} onChange={(e) => set(field, e.target.value)} />
		</div>
	);
}

function ListFields({ draft, set }: { draft: Record<string, string>; set: DraftSetter }) {
	return (
		<div className="agent-character-grid">
			<TextAreaCard field="bio" label="Bio" rows={8} draft={draft} set={set} />
			<TextAreaCard field="lore" label="Lore" rows={8} draft={draft} set={set} />
			<TextAreaCard field="topics" label="Topics" rows={8} draft={draft} set={set} />
			<TextAreaCard field="adjectives" label="Adjectives" rows={8} draft={draft} set={set} />
		</div>
	);
}

function StyleFields({ draft, set }: { draft: Record<string, string>; set: DraftSetter }) {
	return (
		<div className="agent-character-grid">
			<TextAreaCard field="styleAll" label="Style: all" rows={7} draft={draft} set={set} />
			<TextAreaCard field="styleChat" label="Style: chat" rows={7} draft={draft} set={set} />
			<TextAreaCard field="stylePost" label="Style: post" rows={7} draft={draft} set={set} />
		</div>
	);
}

function ExamplesFields({ draft, set }: { draft: Record<string, string>; set: DraftSetter }) {
	return (
		<>
			<TextAreaCard field="postExamples" label="Post examples" rows={8} draft={draft} set={set} />
			<div className="card">
				<label>Message examples JSON</label>
				<textarea
					className="pensieve-textarea agent-character-examples"
					value={draft.messageExamples ?? ""}
					onChange={(e) => set("messageExamples", e.target.value)}
				/>
			</div>
		</>
	);
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
			setDraft(draftFromCharacter(character));
		});
	}, [client]);

	async function save() {
		if (!cfg) return;
		setSaving(true);
		setError(null);
		try {
			const messageExamples = parseExamples(draft.messageExamples ?? "[]");
			const payload = draftCharacter(cfg, draft, messageExamples);
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
			<CharacterHeader saving={saving} onSave={save} />
			{error && <div className="banner error" style={{ marginBottom: 10 }}>{error}</div>}
			{!error && savedAt && <div className="banner success" style={{ marginBottom: 10 }}>Saved. Runtime reloaded.</div>}
			<BasicFields draft={draft} set={set} />
			<SystemField draft={draft} set={set} />
			<ListFields draft={draft} set={set} />
			<StyleFields draft={draft} set={set} />
			<ExamplesFields draft={draft} set={set} />
		</div>
	);
}
