import { useEffect, useState } from "react";
import {
	AUDIO_SETTING_DEFINITIONS,
	type AudioRuntimeSettingKey,
	type SettingDefinition,
} from "../../shared/settings-registry";
import { rpc } from "../rpc";

type AudioField = SettingDefinition & {
	key: AudioRuntimeSettingKey;
	label: string;
	placeholder: string;
};

const ELEVENLABS_FIELDS: readonly AudioField[] = AUDIO_SETTING_DEFINITIONS;

type StoredState = Record<string, { exists: boolean; value: string }>;

async function readField(field: AudioField): Promise<{ exists: boolean; value: string }> {
	try {
		const result = await rpc.request.vaultGetKey({ key: field.key, reveal: !field.sensitive });
		return {
			exists: true,
			value: field.sensitive ? "" : result.value ?? "",
		};
	} catch {
		return { exists: false, value: "" };
	}
}

function AudioFieldRow({
	draft,
	field,
	onRemove,
	onSave,
	onSetDraft,
	stored,
}: {
	draft: string;
	field: AudioField;
	onRemove: (field: AudioField) => void;
	onSave: (field: AudioField) => void;
	onSetDraft: (key: string, value: string) => void;
	stored: { exists: boolean; value: string };
}) {
	const shownValue = draft || (!field.sensitive ? stored.value : "");
	return (
		<div className={field.wide ? "audio-field wide" : "audio-field"}>
			<label>{field.label}</label>
			<div className="row">
				<input
					type={field.sensitive ? "password" : "text"}
					placeholder={
						field.sensitive && stored.exists && !draft
							? "•••••••• stored"
							: field.placeholder
					}
					value={shownValue}
					onChange={(e) => onSetDraft(field.key, e.target.value)}
				/>
				<button type="button" className="btn small" onClick={() => onSave(field)}>
					Save
				</button>
				{stored.exists && (
					<button type="button" className="btn ghost small" onClick={() => onRemove(field)}>
						Remove
					</button>
				)}
			</div>
		</div>
	);
}

function ProviderCard({
	fields,
	name,
	status,
}: {
	fields: readonly AudioField[];
	name: string;
	status: StoredState;
}) {
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [localStatus, setLocalStatus] = useState<StoredState>(status);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setLocalStatus(status);
		setDrafts({});
	}, [status]);

	async function refreshField(field: AudioField) {
		setLocalStatus((s) => ({ ...s, [field.key]: { exists: true, value: field.sensitive ? "" : drafts[field.key] ?? "" } }));
		const next = await readField(field);
		setLocalStatus((s) => ({ ...s, [field.key]: next }));
	}

	async function save(field: AudioField) {
		const value = (drafts[field.key] ?? (!field.sensitive ? localStatus[field.key]?.value : "") ?? "").trim();
		if (!value) return;
		try {
			setError(null);
			await rpc.request.vaultSetKey({ key: field.key, value, sensitive: field.sensitive });
			setDrafts((d) => ({ ...d, [field.key]: "" }));
			await refreshField(field);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function remove(field: AudioField) {
		try {
			setError(null);
			await rpc.request.vaultRemoveKey({ key: field.key });
			setDrafts((d) => ({ ...d, [field.key]: "" }));
			setLocalStatus((s) => ({ ...s, [field.key]: { exists: false, value: "" } }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	const configured = fields[0] ? localStatus[fields[0].key]?.exists : false;

	return (
		<div className="card">
			<div className="provider-header">
				<span className="name">{name}</span>
				<span className={configured ? "badge ok" : "badge muted"}>
					{configured ? "Configured" : "Not configured"}
				</span>
			</div>
			{error && <div className="banner error">{error}</div>}
			<div className="audio-grid">
				{fields.map((field) => (
					<AudioFieldRow
						key={field.key}
						field={field}
						stored={localStatus[field.key] ?? { exists: false, value: "" }}
						draft={drafts[field.key] ?? ""}
						onSave={save}
						onRemove={remove}
						onSetDraft={(key, value) => setDrafts((d) => ({ ...d, [key]: value }))}
					/>
				))}
			</div>
		</div>
	);
}

export function AudioTab() {
	const [status, setStatus] = useState<StoredState>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	async function refresh() {
		try {
			setError(null);
			const entries = await Promise.all(ELEVENLABS_FIELDS.map(async (field) => [field.key, await readField(field)] as const));
			setStatus(Object.fromEntries(entries));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Audio</h3>
			<p className="hint">
				Voice, sound effects, and music keys used by the agent actions.
			</p>
			{error && <div className="banner error">{error}</div>}
			{loading ? (
				<div className="empty">Loading audio settings…</div>
			) : (
				<>
					<ProviderCard name="ElevenLabs" fields={ELEVENLABS_FIELDS} status={status} />
				</>
			)}
		</div>
	);
}
