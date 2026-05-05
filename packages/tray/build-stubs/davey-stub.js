// Stub for @snazzah/davey — Discord voice DAVE protocol bindings.
//
// The real package wraps a native .node binding. Bun's bundler bundles the
// .node file but the package's own loader (which uses createRequire to find
// platform-specific subpackages by name) can't resolve them in the bundled
// .app, so it throws at module-eval time. That kills the whole agent during
// startup since plugin-discord statically imports voice → @discordjs/voice
// → @snazzah/davey.
//
// We don't ship Discord voice features — text messaging is what the agent
// needs. This stub satisfies the surface @discordjs/voice consumes
// (DAVESession constructor, MediaType enum, DAVE_PROTOCOL_VERSION) so
// import-time evaluation succeeds. If voice features are ever invoked at
// runtime, the stub session methods are no-ops.

class DAVESession {
	constructor() {}
	setExternalSender() {}
	getSerializedKeyPackage() { return Buffer.alloc(0); }
	processProposals() { return Buffer.alloc(0); }
	processCommit() {}
	processWelcome() {}
	encryptOpus(_uid, payload) { return payload; }
	decrypt(_uid, _type, payload) { return payload; }
	dispose() {}
	get protocolVersion() { return 0; }
	get voicePrivacyCode() { return ""; }
	get userPrivacyCode() { return ""; }
}

const stub = {
	DAVE_PROTOCOL_VERSION: 0,
	DAVESession,
	DaveSession: DAVESession,
	Codec: { Opus: 0, AV1: 1, VP8: 2, VP9: 3, H264: 4, H265: 5 },
	MediaType: { AUDIO: 0, VIDEO: 1 },
	ProposalsOperationType: { Append: 0, Revoke: 1 },
	SessionStatus: { Inactive: 0, Active: 1, Suspended: 2 },
	DEBUG_BUILD: false,
};

module.exports = stub;
module.exports.default = stub;
