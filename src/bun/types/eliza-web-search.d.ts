// `@elizaos-plugins/plugin-web-search` ships an ESM bundle but no `.d.ts` —
// its `tsup --dts` step is broken under the current TypeScript toolchain
// (deprecated `baseUrl`). Declare the surface Detour actually consumes — the
// Plugin object — so `tsc` resolves the import without depending on the
// missing declarations or pulling the plugin's (non-strict) source into our
// strict typecheck. The runtime uses the real built bundle from node_modules.
declare module "@elizaos-plugins/plugin-web-search" {
	import type { Plugin } from "@elizaos/core";
	export const webSearchPlugin: Plugin;
	const _default: Plugin;
	export default _default;
}
