/** Research-then-riff: pull a few live facts for a topic from Tavily so a post is
 *  grounded in what actually happened. Returns a short context block, or "" when no
 *  key is configured or the call fails (generation then proceeds ungrounded).
 *
 *  Pure leaf: takes apiKey as a parameter, does NOT read process.env or the vault.
 *  No Detour imports. */
export async function buildResearchContext(topic: string, apiKey: string): Promise<string> {
	const key = apiKey.trim();
	if (!key || !topic.trim()) return "";
	try {
		const r = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({ query: topic, max_results: 4, search_depth: "basic" }),
			signal: AbortSignal.timeout(4000),
		});
		if (!r.ok) return "";
		const j = (await r.json()) as { results?: Array<{ title?: string; content?: string; url?: string }> };
		const lines = (j.results ?? [])
			.slice(0, 4)
			.map((x, i) => `fact[${i}]: ${x.title ?? ""} | ${(x.content ?? "").slice(0, 220)}`)
			.filter((l) => l.length > 12);
		if (lines.length === 0) return "";
		return ["Live research (ground your take in these, do not invent beyond them):", ...lines].join("\n");
	} catch {
		return "";
	}
}
