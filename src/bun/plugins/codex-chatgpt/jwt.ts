/**
 * Minimal JWT decoder — no validation, just base64url-decodes the payload.
 * Codex CLI tokens carry a custom claim at `https://api.openai.com/auth`
 * which contains `chatgpt_account_id` (required header for inference calls).
 */

export interface CodexJwtClaims {
	readonly chatgptAccountId: string | null;
	readonly organizationId: string | null;
	readonly projectId: string | null;
	readonly raw: Record<string, unknown>;
}

const AUTH_CLAIM = "https://api.openai.com/auth";

function base64UrlDecode(input: string): string {
	const pad = "====".slice(0, (4 - (input.length % 4)) % 4);
	const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(b64, "base64").toString("utf8");
}

export function decodeCodexJwt(token: string): CodexJwtClaims | null {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(base64UrlDecode(parts[1]!)) as Record<string, unknown>;
	} catch {
		return null;
	}
	const auth = (payload[AUTH_CLAIM] as Record<string, unknown> | undefined) ?? {};
	return {
		chatgptAccountId: typeof auth.chatgpt_account_id === "string" ? (auth.chatgpt_account_id as string) : null,
		organizationId: typeof auth.organization_id === "string" ? (auth.organization_id as string) : null,
		projectId: typeof auth.project_id === "string" ? (auth.project_id as string) : null,
		raw: payload,
	};
}
