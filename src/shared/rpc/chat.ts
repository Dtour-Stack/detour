// Reserved for chat streaming migration (chat:delta / chat:complete /
// chat:error). Currently empty — those still flow over WS. When chat
// streaming migrates, add ChatRequests / ChatMessages exports here and
// intersect them in src/shared/rpc/index.ts.
//
// This file is intentionally a placeholder; per the index file's
// guidance, empty types must NOT be intersected because
// `Record<string, never>` introduces an index signature that breaks
// per-key handler typechecking.
export {};
