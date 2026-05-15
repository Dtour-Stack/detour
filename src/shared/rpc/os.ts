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
	/**
	 * Quit the Detour app process. Used by the tray popover's footer
	 * Quit button. Goes through Utils.quit for graceful CEF cleanup;
	 * the before-quit shutdown hooks in src/bun/index.ts still fire.
	 */
	appQuit: {
		params: Record<string, never>;
		response: { ok: true };
	};
};
