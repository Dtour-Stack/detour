---
type: "tags-index"
topics: 12
projects: 56
tags: ["moc", "tags"]
---

# 🏷️ Tag Index

Every session carries `tool/`, `project/`, `topic/`, and `scope/` tags. The **same `topic/*` tag is reused across projects** — that overlap is what lets you find *“where have I solved this before”* across your whole history.

## Scope (depth)

| Scope | Sessions | Meaning |
|---|---|---|
| `#scope/general` | 636 | reusable across 2+ projects (skill-worthy) |
| `#scope/project-specific` | 653 | tied to one repo's setup/quirks |
| `#scope/surface` | 1368 | shallow one-off / trivial |

## Topics — and the projects they overlap

| Topic | Sessions | # Projects | Projects | Cross-project? |
|---|---|---|---|---|
| `#topic/agent-tooling` | 1385 | 38 | `actantdb`, `audit-fixes-locallllm-models`, `booth`, `can-we-get-this-running-on`, `comfy`, `ddtour`… | ✅ general |
| `#topic/git-ci` | 873 | 26 | `actantdb`, `audit-fixes-locallllm-models`, `can-we-get-this-running-on`, `claude`, `ddtour`, `detour`… | ✅ general |
| `#topic/testing-e2e` | 732 | 27 | `actantdb`, `audit-fixes-locallllm-models`, `booth`, `can-we-get-this-running-on`, `ddtour`, `detour`… | ✅ general |
| `#topic/api-server` | 440 | 31 | `actantdb`, `audit-fixes-locallllm-models`, `bloodhound`, `booth`, `can-we-get-this-running-on`, `claude`… | ✅ general |
| `#topic/frontend-ui` | 418 | 23 | `actantdb`, `audit-fixes-locallllm-models`, `bloodhound`, `booth`, `can-we-get-this-running-on`, `claude`… | ✅ general |
| `#topic/blockchain` | 245 | 22 | `actantdb`, `can-we-get-this-running-on`, `ddtour`, `detour`, `dtour-cloud`, `eliza`… | ✅ general |
| `#topic/dependency-install` | 234 | 20 | `actantdb`, `booth`, `claude`, `ddtour`, `detour`, `documents`… | ✅ general |
| `#topic/typescript-build` | 180 | 22 | `actantdb`, `booth`, `can-we-get-this-running-on`, `claude`, `core`, `ddtour`… | ✅ general |
| `#topic/database` | 171 | 15 | `actantdb`, `audit-fixes-locallllm-models`, `booth`, `claude`, `detour`, `dtour-cloud`… | ✅ general |
| `#topic/native-build` | 146 | 14 | `booth`, `can-we-get-this-running-on`, `claude`, `ddtour`, `detour`, `documents`… | ✅ general |
| `#topic/infra-docker` | 77 | 11 | `actantdb`, `claude`, `detour`, `documents`, `dtour-cloud`, `eliza`… | ✅ general |
| `#topic/disk-space` | 72 | 12 | `actantdb`, `can-we-get-this-running-on`, `detour`, `documents`, `dtour-cloud`, `eliza`… | ✅ general |

## Projects

| Project | Sessions |
|---|---|
| `#project/scratch` | 1009 |
| `#project/swoosh` | 334 |
| `#project/milady` | 110 |
| `#project/actantdb` | 89 |
| `#project/detour` | 80 |
| `#project/audit-fixes-locallllm-models` | 64 |
| `#project/dtour-cloud` | 57 |
| `#project/the-family` | 53 |
| `#project/eliza` | 41 |
| `#project/weclank` | 23 |
| `#project/unknown` | 23 |
| `#project/home` | 23 |
| `#project/swooshcli-audit-fixes` | 14 |
| `#project/teardown-on-feat-next` | 14 |
| `#project/claude` | 11 |
| `#project/booth` | 6 |
| `#project/v1` | 5 |
| `#project/goals-manifesting-followups` | 5 |
| `#project/plugin-agent-orchestrator` | 5 |
| `#project/tests` | 5 |
| `#project/ddtour` | 4 |
| `#project/merc` | 4 |
| `#project/human-cache` | 3 |
| `#project/printing-press` | 2 |
| `#project/untitled-folder` | 2 |
| `#project/untitled-folder-2` | 2 |
| `#project/swift` | 2 |
| `#project/remnants` | 2 |
| `#project/can-we-get-this-running-on` | 2 |
| `#project/sync` | 1 |
| `#project/electrobun` | 1 |
| `#project/agent-orchestrator-claude-reuse-1rawwr` | 1 |
| `#project/mainview` | 1 |
| `#project/persistence-slice` | 1 |
| `#project/macos-hub` | 1 |
| `#project/loving-leavitt-7e31d4` | 1 |
| `#project/agent-orchestrator-claude-reuse-1tay0z` | 1 |
| `#project/agent-orchestrator-claude-reuse-c4l9ma` | 1 |
| `#project/dev-tools` | 1 |
| `#project/server` | 1 |
| `#project/freellmapi` | 1 |
| `#project/documents` | 1 |
| `#project/core` | 1 |
| `#project/bloodhound` | 1 |
| `#project/agent-orchestrator-claude-reuse-ei6v1p` | 1 |
| `#project/comfy` | 1 |
| `#project/remove-dashboard-tray` | 1 |
| `#project/elated-kapitsa-5b80c5` | 1 |
| `#project/mlp` | 1 |
| `#project/there-is-a-challenge-to-email` | 1 |

---
```dataview
TABLE length(rows) as Sessions FROM #agent-session FLATTEN topics as topic GROUP BY topic SORT length(rows) DESC
```
