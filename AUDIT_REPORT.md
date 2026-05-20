# DETOUR SYSTEM AUDIT REPORT

## 1. Executive Summary

This report presents a comprehensive system architecture audit and security evaluation of **Detour**, an Electrobun-based macOS desktop and menu-bar application. Detour orchestrates local and cloud-based autonomous agent workflows by combining a React frontend, an in-process Bun core backend services layer, a dynamically-linked `elizaOS` runtime submodule, and an isolated Web Worker plugin system ("carrots"). State persistence and memory management are handled via **Pensieve**, a dedicated relational memory layer powered by `@electric-sql/pglite` (Postgres running in WebAssembly).

### Key Audit Findings

*   **Robust Security Architecture**: Key management (Vault) is exceptionally secure, employing **AES-256-GCM** encryption with Additional Authenticated Data (AAD) slot path protection. Writes are performed atomically with explicit `0o600` permissions. Master key resolution correctly leverages a tiered hierarchy (OS Keychain fallback to scrypt-derived passphrases).
*   **Isolated Wallet Operations**: The Phantom Wallet Connect integration dynamically derives redirection parameters using `DETOUR_DEV_URL` and `PHANTOM_PORTLESS_FQDN` routes. It is securely isolated to first-party WebView partitions, preventing credential and session-hijacking vulnerabilities in the general agent browser.
*   **Performance Bottlenecks**: Significant performance and scalability concerns exist due to PGlite running synchronously in the main JavaScript thread (blocking synchronous CPU compute rather than asynchronous I/O) and the high serialization costs of the Structured Clone Algorithm used in Carrot Web Worker IPC.
*   **Conformal Integration**: Google Antigravity platforms, XHawk telemetry capture, and Opencode configurations are seamlessly mapped, allowing multi-provider agent session continuity and dynamic logging fallback.
*   **Test Suite Modernization**: Resolved a regression in the DPE fallback plugin test suite (`dpe-fallback-plugin.test.ts`) caused by stale references to deprecated structured retry and provider recovery features (removed in the 2026-05 refactor). Legacy tests have been pruned, and coverage has been introduced for active features, specifically the Companion pre-pass and Quota-cap short-circuiting.

---

## 2. System Architecture Audit

### 2.1 Electrobun Frontend Layer
Detour's user interface is built using React and Vite. In production, the UI components load locally via the `views://main/<view>.html` custom protocol (in development, it hot-reloads from `http://localhost:5180` to facilitate rapid iteration).
*   **Routing Mechanism**: Rather than relying on standard router fragments which can cause scheme parsing issues over custom protocols, views are dynamically rendered based on `window.__detourView` (injected by view HTML wrappers) or `window.location.hash`.
*   **UI Surfaces**: Composed of several specialized modules:
    *   `chat/`: Handles popover conversation interface and displays active provider status.
    *   `pensieve/`: Visual memory, relationship, template, and 3D embedding map browser.
    *   `activity/`: Displays agent trajectories, task states, live log streams, and raw database tables.
    *   `channels/`: Configuration controls for Telegram, Discord, and iMessage connectors.
    *   `settings/`: Vault credential registration and local LLM/embedding configuration.
    *   `browser/`: Isolated web views using the `detour-agent-browser` partition for secure browser automation.
    *   `wallet/`: Implements the multi-chain Phantom Connect wallet layout.
*   **Configuration**: The frontend is integrated with the Bun core via `electrobun.config.ts`. It designates Chromium Embedded Framework (CEF) as the default rendering engine across macOS, Windows, and Linux. This bypasses User-Agent string parsing anomalies inherent to macOS WKWebView during the Phantom Portal connect flow.

### 2.2 Bun Core Services & RPC
The application backend runs in-process inside Bun, loading canonical state under the `~/.detour/` home directory.
*   **Composition Root**: Formulated in `src/bun/core/index.ts` and `src/bun/core/api/server.ts`, spawning services including `VaultService`, `AuthService`, `ConfigService`, `ChannelsService`, `RuntimeService`, `PensieveService`, `CompanionService`, and `PortlessService`.
*   **API & RPC Gateways**: Exposes a local HTTP/WebSocket API server on `127.0.0.1:2138` (configurable). High-speed Electrobun-to-Bun communication is mediated through typed RPC handlers defined in `src/shared/rpc/` and implemented in `src/bun/core/rpc/handlers/` (e.g. `pensieve.ts`, `phantom.ts`, `chat.ts`). A high-performance alternative is provided via Unix Domain Sockets (`src/bun/core/rpc-socket.ts`), yielding ~80µs IPC latency compared to the standard ~1ms HTTP loopback overhead.

### 2.3 ElizaOS Package Integrations
Detour tracks the `develop` branch of the `eliza/` submodule, building packages natively via `bun run build:eliza`.
*   **Dynamic Runtime**: `src/bun/core/runtime.ts` instantiates the eliza `AgentRuntime` on-demand based on active credential configurations.
*   **Submodule Plugins**: Loads standard eliza packages including `@elizaos/plugin-sql` (PGlite database adapter), `@elizaos/plugin-anthropic` & `@elizaos/plugin-openai` (cloud inference providers), `@elizaos/plugin-coding-tools`, and `@elizaos/plugin-agent-orchestrator`.
*   **Claude Code Stealth Interceptor**: Implemented in `src/bun/core/auth.ts` via `enableClaudeCodeStealth()`, this utility registers an in-memory global fetch interceptor. When intercepting calls to `api.anthropic.com` carrying a Claude Code OAuth token (`sk-ant-oat...`), it:
    *   Injects matching headers: `user-agent` to `claude-cli/2.1.92 (external, cli)` and `x-app` to `cli`.
    *   Prepends system prompts with `"You are Claude Code, Anthropic's official CLI for Claude."` to spoof agent telemetry.

### 2.4 Custom Carrot Runtime
The Carrot system (`src/bun/core/carrots/`) implements a worker-based sandboxing environment for background plugins (e.g. `carrots/cron-tools/`).
*   **Worker Isolation**: Sandboxes run in isolated `Bun.Worker` threads. System capability limits are enforced by feeding `bunPermissions` from `carrot.json` directly to the `Worker` constructor options.
*   **Host Security Boundaries**: The host implements a `ServiceRegistry` containing strict allowlists for RPC communication. For instance, the `vault` service only exposes `hasMasterKey`, `listSecretIds`, and `getSecret` to workers. The host rejects write-level secret operations over worker IPC.
*   **Token Leases**: To prevent sandbox escape, the `IAgentRuntime` is proxied using a temporary `runtimeToken` leased solely for the lifecycle of an action execution (`invokeAction`/`invokeProvider`) and released immediately afterward.

### 2.5 PGlite Memory Layers (Pensieve)
The agent's memory backend integrates `@electric-sql/pglite` to support vector search capabilities (`pgvector`) and fuzzy matching (`fuzzystrmatch`).
*   **Concurrency & Locking**: Multi-process directory access is mitigated by `PGliteClientManager` (`eliza/plugins/plugin-sql/typescript/pglite/manager.ts`) using file-system lock files:
    *   `eliza-pglite.lock`: A process-exclusive lock containing process ID and creation metadata.
    *   `postmaster.pid`: Maintained by the underlying Postgres WASM compiler engine.
*   **Lock Reconciliation**: On startup, `reconcilePglitePidFile` and `acquireDataDirLockIfNeeded` query active process ownership via `process.kill(pid, 0)`. If a lock is held by a dead process (`ESRCH` code returned), the manager unlinks the stale files automatically.
*   **Compute Contention**: PGlite executes within the main thread, meaning query computation blocks JS event-loop cycles. High concurrency is serialized via process-level mutexes (`withStoreMutationLock`).

### 2.6 Google Antigravity & XHawk Telemetry
*   **XHawk Configuration**: Developer sessions and agent run state tracking are configured via `/Users/home/Projects/detour/.xhawk/settings.json`.
*   **Editor Bridge**: Tracks Antigravity as a compatible code editor. It executes the CLI command `ag` inside `/Applications/Antigravity.app` via `editor-bridge.ts`.
*   **Vertex AI Support**: Plugs in Vertex AI models through `@elizaos/plugin-google-antigravity`, auto-enabling when `GOOGLE_CLOUD_API_KEY` is present.
*   **Opencode Settings**: Accounts and budget policies are configured dynamically in `.opencode/antigravity.json` and `opencode.json`, implementing account selection strategies (such as `round-robin` rotation) and fallback routes (e.g. falling back to Gemini if Claude prompts return 429 rate limit errors).

### 2.7 Test Architecture & Modernization
Detour's backend verification strategy employs `bun:test` to perform high-fidelity unit testing of runtime plugins and safety-net components.
*   **DPE Fallback Verification**: The post-planner safety net (`dpe-fallback-plugin.ts`) wraps Eliza's `dynamicPromptExecFromState` to catch failures. In the 2026-05 refactor, legacy tier cascades, structured retries, and provider recovery paths were deprecated in favor of a streamlined freeform planner.
*   **Regression Remediation**: Outdated tests targeting these deprecated features were pruned from `dpe-fallback-plugin.test.ts` to restore test suite health. New tests have been introduced to cover:
    *   **Companion Pre-pass**: Validating persona-framing hooks and recent message compression (when the conversation history exceeds character limits) to ensure state augmentation is strictly additive.
    *   **Quota-cap Short-circuiting**: Verifying that if an active provider (tracked via `ProviderQuotaService`) exceeds its usage limits, the system intercepts downstream model execution and returns a clear, user-facing capped notice.

---

## 3. Scorecard & Evaluation

| Category | Grade | Technical Rationale |
| :--- | :---: | :--- |
| **Architecture** | **A-** | Neat division between UI layer, Bun RPC services, and ElizaOS plugins. High-speed Unix domain socket IPC provides excellent latency profiles (~80µs). However, managing cross-process state and submodules adds structural complexity. |
| **Security** | **A** | State-of-the-art key vault utilizing AES-256-GCM with path-based AAD protection. Atomic writes with `0o600` POSIX file permissions prevent race conditions. High-security WebView isolation protects critical wallet authentication vectors from unauthorized access. |
| **Scalability** | **C+** | Heavy vector indexing and relational memory operations in PGlite block the main JavaScript thread synchronously due to WASM constraints. Spawning dedicated Bun Worker instances scales memory consumption linearly. IPC structured cloning adds measurable compute overhead on large state payloads. |
| **Modularity** | **A-** | ElizaOS submodule plugins and custom Carrot sandboxes enforce clean boundaries. Extending capabilities requires minimal modifications to the core application layout. |
| **Global System Grade** | **B+** | A highly secure, modular desktop agent runtime. It is architectural grade-A material, but currently bounded by performance/threading bottlenecks in the database and serialization levels. |

---

## 4. Security Analysis Details

### 4.1 Vault Key Management
The credential vault (`eliza/packages/vault/`) protects API keys and sensitive settings.
*   **Encryption Standard**: Cryptographic operations are handled via `eliza/packages/vault/src/crypto.ts` utilizing `aes-256-gcm`.
*   **AAD Integrity Binding**: To prevent ciphertext copy-paste attacks (where an encrypted secret is swapped into another credential field), the key identifier path is bound as Additional Authenticated Data (AAD):
    ```typescript
    cipher.setAAD(Buffer.from(aad, "utf8"));
    ```
    Decryption fails immediately if the AAD does not match the secret path during retrieval.
*   **Atomic Writes**: The vault is persisted to `<workDir>/vault.json`. To prevent concurrent writes from truncating data, updates are written to a temp file (`vault.json.tmp.<pid>.<random>`) with explicit `0o600` permissions (owner read/write only). The file is then atomically swapped via POSIX `rename`, inheriting the `0o600` permissions securely.
*   **Master Key Hierarchy**: Resolves via three fallback tiers:
    1.  **OS Keychain**: Integrates `@napi-rs/keyring` to query macOS Keychain Services under service `"eliza"` and account `"vault.masterKey"`.
    2.  **Passphrase KDF**: Under headless environments or if bypassed via `ELIZA_VAULT_DISABLE_KEYCHAIN=1`, the system derives a 32-byte key via `scrypt` using the environment variable `ELIZA_VAULT_PASSPHRASE`.
    3.  **In-Memory**: A temporary mock master key used strictly in test environments.

### 4.2 Phantom Wallet Connect & Portal Integration
*   **Multi-Chain Support**: The wallet implementation in `src/bun/core/rpc/handlers/phantom.ts` natively handles both Solana and EVM chains.
*   **Dynamic Redirect Resolution**: Dynamic Allowed Origins and Redirect URLs are calculated dynamically in `phantomGetPortalConfig` to match the exact environment (local development, tunnels, or production):
    *   If `DETOUR_DEV_URL` is set to a non-local tunnel address, it is used as the redirect origin.
    *   If portless routing is active, the redirect is resolved via `PHANTOM_PORTLESS_FQDN` or `<host>.<tld>` pointing to the active Vite port.
    *   Fallback maps directly to the bundled app shell (`views://main/index.html`).
*   **WebView Partition Isolation**: Embedded Phantom Connect flows run exclusively on first-party surfaces (using `detour-wallet` or the main React shell partition). The flow is strictly prohibited from running inside the general `detour-agent-browser` partition where untrusted HTTPS pages are loaded. This protects against host redirect hijacking and OAuth state poisoning.

---

## 5. Identified Issues & Actionable Improvement Tickets

### TICKET-01: PGlite WASM Synchronous Blocking Thread
*   **Description**: The PGlite WASM Postgres database executes query computation synchronously on the main JavaScript thread instead of utilizing non-blocking asynchronous socket I/O.
*   **Impact**: Large vector search queries or complex database joins block the event loop, causing UI stuttering, RPC latency spikes, and blocking responsiveness of other backend core services.
*   **Remediation Steps**: Offload the PGlite database client to a dedicated Web Worker thread (e.g. `Bun.Worker`). Create an asynchronous message passing protocol wrapper (actor model) between the host services and the PGlite worker.
*   **Severity / Priority**: **High / High**
*   **Affected File Paths**:
    *   `eliza/plugins/plugin-sql/typescript/pglite/manager.ts`
    *   `eliza/plugins/plugin-sql/typescript/pglite/adapter.ts`
    *   `src/bun/core/pensieve/memory-service.ts`

### TICKET-02: Carrot Runtime Structured Clone IPC Serialization Overhead
*   **Description**: The Carrot plugin runtime executes communication with worker sandboxes using `postMessage`, which relies on the Structured Clone Algorithm. For every action execution (`invokeAction`), large context objects, message histories, and system prompts are fully serialized.
*   **Impact**: Measurable latency overhead (~10-50ms) and garbage collection thrashing when processing complex agent states (1MB+ states), limiting high-frequency action loops.
*   **Remediation Steps**: Implement a shared-memory layout utilizing `SharedArrayBuffer` for large payloads, or use a high-performance binary serialization format (e.g. Protocol Buffers, MessagePack). Alternatively, restrict IPC payload transfers by storing the state on the host and passing reference tokens to the worker to fetch sliced sections on-demand.
*   **Severity / Priority**: **Medium / Medium**
*   **Affected File Paths**:
    *   `src/bun/core/carrots/host-loader.ts`
    *   `src/bun/core/carrots/plugin-adapter.ts`
    *   `carrots/cron-tools/worker.ts`

### TICKET-03: OS Keychain Keyring Fallback Silent Failures and Insecure Logs
*   **Description**: When `@napi-rs/keyring` fails to load under headless Linux environments lacking D-Bus sessions, the system falls back to passphrase KDF or test in-memory storage. The fallback mechanism does not explicitly surface warnings regarding the lack of secure persistent storage.
*   **Impact**: Administrators may run agents in production environments unaware that the master encryption key is derived from insecure, temporary, or missing settings, leaving vault secrets vulnerable to exposure.
*   **Remediation Steps**: Introduce explicit, high-visibility warnings to stderr/console logs when a fallback from the native keychain occurs, and abort start in production environments if neither native keyring nor `ELIZA_VAULT_PASSPHRASE` is explicitly configured.
*   **Severity / Priority**: **Low / Medium**
*   **Affected File Paths**:
    *   `eliza/packages/vault/src/master-key.ts`
    *   `src/bun/core/index.ts`

### TICKET-04: PGlite Data Directory Lock Invalidation Race Conditions
*   **Description**: The PGlite lock reconciliation checks process ownership using `process.kill(pid, 0)`. While this clears stale locks, it introduces a potential race window where a fast-rebooting daemon uses a stale PID that is subsequently reassigned by the OS.
*   **Impact**: Possible database initialization failure or data corruption if another active process is misidentified as the database owner, or if lock files are deleted during database read/write sequences.
*   **Remediation Steps**: Incorporate process startup timestamps or unique UUID tokens inside `eliza-pglite.lock` and compare them with the active system process table to prevent PID collision false-positives.
*   **Severity / Priority**: **Medium / Low**
*   **Affected File Paths**:
    *   `eliza/plugins/plugin-sql/typescript/pglite/manager.ts`

### TICKET-05: DPE Fallback Test Suite Regression [RESOLVED]
*   **Description**: The unit test suite `dpe-fallback-plugin.test.ts` contained outdated tests asserting deprecated features (such as provider recovery, structured retry, and tier cascades) that were removed during the 2026-05 refactor.
*   **Impact**: Caused verification errors and 12 failing tests, breaking local builds and telemetry validation pipelines.
*   **Remediation Steps**: Pruned the deprecated test scenarios and introduced coverage for the active safety-net behaviors: companion pre-pass (persona framing and message history compression) and quota-cap short-circuiting. Verified that all tests pass and that the file is typecheck compliant.
*   **Severity / Priority**: **Medium / High**
*   **Affected File Paths**:
    *   `src/bun/core/dpe-fallback-plugin.test.ts`

### TICKET-06: Unregistered Carrot Services in Composition Root
*   **Description**: The composition root (`src/bun/core/index.ts`) initializes and boots `VaultService`, `PensieveService`, `ChannelsService`, and `LlamaServerService`, but fails to register them with the `CarrotManager` Service Registry. Currently, only the `cron` service is registered. However, the Carrot plugin configurations (e.g. allowlists in `carrot.json`) expect direct RPC access to `vault`, `pensieve`, `channels`, and `llama` capability gateways.
*   **Impact**: Any installed worker plugins (carrots) attempting to utilize SDK functions mapped to `vault`, `pensieve`, `channels`, or `llama` will fail silently or throw runtime errors during invocation due to missing service registrations in the host registry, rendering these integration routes non-functional.
*   **Remediation Steps**: Update the composition root (`src/bun/core/index.ts`) to call `carrotManager.registerService` for the missing services (`vault`, `pensieve`, `channels`, and `llama`), exposing the approved host capability sets.
*   **Severity / Priority**: **High / Medium**
*   **Affected File Paths**:
    *   `src/bun/core/index.ts`

### TICKET-07: Obsolete/Broken Script Reference in package.json
*   **Description**: The `package.json` file contains a script entry `"verify:phantom-extension": "bun run scripts/verify-phantom-extension.ts"`. However, the script file `scripts/verify-phantom-extension.ts` does not exist in the repository's `scripts/` directory.
*   **Impact**: Developers or CI/CD pipelines executing `bun run verify:phantom-extension` will experience immediate failures, confusing local verification processes and cluttering package configurations with obsolete targets.
*   **Remediation Steps**: Clean up the `"verify:phantom-extension"` target in `package.json` or restore/implement the missing `verify-phantom-extension.ts` validation script if required.
*   **Severity / Priority**: **Low / Low**
*   **Affected File Paths**:
    *   `package.json`
