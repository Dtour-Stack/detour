import { Utils } from "electrobun/bun";
import type { OsPermissionId, OsPermissionInfo } from "../../../../shared/index";
import { listPermissions, openPermissionPane, type PermissionId } from "../../os-permissions";
import type { RpcDeps } from "../types";

/**
 * macOS TCC permissions — list status + deep-link to the matching System
 * Settings pane. Replaces:
 *   - GET  /api/os/permissions          → osListPermissions
 *   - POST /api/os/permissions/<id>/open → osOpenPermissionPane
 */
export function osRequests(_deps: RpcDeps) {
	return {
		osListPermissions: async (_params: Record<string, never>): Promise<OsPermissionInfo[]> => {
			// listPermissions returns PermissionInfo[] (bun-side type), which is
			// structurally identical to the shared OsPermissionInfo[] used over
			// the wire.
			return (await listPermissions()) as unknown as OsPermissionInfo[];
		},
		osOpenPermissionPane: async (params: { id: OsPermissionId }): Promise<{ ok: true }> => {
			await openPermissionPane(params.id as PermissionId);
			return { ok: true };
		},
		appQuit: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			// Defer the actual quit so the RPC response can return first;
			// otherwise Electrobun tears the webview down before the
			// caller's await resolves and the popover renders an ugly
			// "RPC error" before disappearing.
			setTimeout(() => Utils.quit(), 50);
			return { ok: true };
		},
	};
}
