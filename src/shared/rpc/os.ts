/**
 * macOS TCC permissions surface. Replaces:
 *   - GET  /api/os/permissions          → osListPermissions
 *   - POST /api/os/permissions/<id>/open → osOpenPermissionPane
 */
import type { OsPermissionId, OsPermissionInfo } from "../index";

export type OsRequests = {
	osListPermissions: {
		params: Record<string, never>;
		response: OsPermissionInfo[];
	};
	osOpenPermissionPane: {
		params: { id: OsPermissionId };
		response: { ok: true };
	};
};
