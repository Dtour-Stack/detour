/**
 * System browser passthrough — opens an https:// URL in the user's default
 * browser via Electrobun's Utils.openExternal. Replaces POST /api/external/open.
 *
 * URL validation (https?:// only) lives on the bun side; the schema is
 * intentionally narrow.
 */
export type ExternalRequests = {
	externalOpen: {
		params: { url: string };
		response: { ok: true };
	};
};
