import { useEffect, useMemo, useState } from "react";
import type { WebClient } from "../../api/client";

type Entry = {
	key: string;
	category: string;
	label?: string;
	hasProfiles?: boolean;
	lastModified?: number;
	kind?: string;
	provider?: string | null;
};

export function InventoryTab({ client }: { client: WebClient }) {
	const [items, setItems] = useState<Entry[]>([]);
	const [stats, setStats] = useState<{
		total: number;
		sensitive: number;
		nonSensitive: number;
		references: number;
	} | null>(null);
	const [filter, setFilter] = useState("");
	const [revealing, setRevealing] = useState<Record<string, string>>({});
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const [newSensitive, setNewSensitive] = useState(true);

	async function refresh() {
		const [list, s] = await Promise.all([
			client.listVaultInventory(),
			client.vaultStats(),
		]);
		setItems(list as Entry[]);
		setStats(s);
	}

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const filtered = useMemo(() => {
		if (!filter) return items;
		const q = filter.toLowerCase();
		return items.filter(
			(i) =>
				i.key.toLowerCase().includes(q) ||
				(i.category ?? "").toLowerCase().includes(q),
		);
	}, [items, filter]);

	async function reveal(key: string) {
		const r = await client.getVaultKey(key, true);
		setRevealing((s) => ({ ...s, [key]: r.value ?? "" }));
	}

	function hide(key: string) {
		setRevealing((s) => {
			const { [key]: _, ...rest } = s;
			return rest;
		});
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
	}

	async function remove(key: string) {
		if (!confirm(`Remove "${key}" from vault?`)) return;
		await client.removeVaultKey(key);
		await refresh();
	}

	async function addKey() {
		if (!newKey.trim() || !newValue) return;
		await client.setVaultKey(newKey.trim(), newValue, newSensitive);
		setNewKey("");
		setNewValue("");
		setAdding(false);
		await refresh();
	}

	return (
		<div>
			<div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
				<h3 style={{ margin: 0, flex: 1 }}>
					Vault inventory
					{stats && (
						<span style={{ marginLeft: 12, fontSize: 12, color: "var(--fg-muted)" }}>
							({stats.total} total · {stats.sensitive} sensitive · {stats.nonSensitive} config · {stats.references} refs)
						</span>
					)}
				</h3>
				<button type="button" className="btn" onClick={() => setAdding((a) => !a)}>
					{adding ? "Cancel" : "+ Add key"}
				</button>
			</div>

			{adding && (
				<div className="provider" style={{ marginBottom: 16 }}>
					<div className="row" style={{ gap: 8, marginBottom: 8 }}>
						<input
							type="text"
							placeholder="key (e.g., my.api.token)"
							value={newKey}
							onChange={(e) => setNewKey(e.target.value)}
						/>
						<label style={{ fontSize: 12, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
							<input
								type="checkbox"
								checked={newSensitive}
								onChange={(e) => setNewSensitive(e.target.checked)}
							/>{" "}
							Sensitive (encrypted)
						</label>
					</div>
					<div className="row">
						<input
							type={newSensitive ? "password" : "text"}
							placeholder="value"
							value={newValue}
							onChange={(e) => setNewValue(e.target.value)}
						/>
						<button type="button" className="btn" onClick={addKey}>
							Save
						</button>
					</div>
				</div>
			)}

			<input
				type="text"
				placeholder="Filter…"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				style={{ marginBottom: 12 }}
			/>

			{filtered.length === 0 ? (
				<div className="hint">No vault entries.</div>
			) : (
				filtered.map((item) => {
					const revealed = revealing[item.key];
					return (
						<div className="provider" key={item.key} style={{ marginBottom: 6 }}>
							<div className="provider-header">
								<span className="name" style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
									{item.key}
								</span>
								<span className="badge muted">{item.category}</span>
							</div>
							<div className="row">
								{revealed != null ? (
									<>
										<input
											type="text"
											value={revealed}
											readOnly
											style={{ fontFamily: "ui-monospace, Menlo, monospace" }}
										/>
										<button type="button" className="btn secondary" onClick={() => copy(revealed)}>
											Copy
										</button>
										<button type="button" className="btn secondary" onClick={() => hide(item.key)}>
											Hide
										</button>
									</>
								) : (
									<>
										<button type="button" className="btn" onClick={() => reveal(item.key)}>
											Reveal
										</button>
										<button type="button" className="btn secondary" onClick={() => remove(item.key)}>
											Delete
										</button>
									</>
								)}
							</div>
						</div>
					);
				})
			)}
		</div>
	);
}
