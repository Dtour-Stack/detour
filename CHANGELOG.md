# Changelog

## [0.4.0](https://github.com/Dexploarer/detour/compare/v0.3.0...v0.4.0) (2026-05-14)


### Features

* add media, audio, desktop-control, goal, dream, and provider-quota services
* add channel-neutral coding task handoff, preview URL return, and workspace agent surfaces
* expand Pensieve/activity context across channels and always-on provider state


### Bug Fixes

* fix frozen Bun installs in CI by syncing `bun.lock`
* fix canary/release workflow version stamping before frozen install
* fix macOS app packaging by copying the committed `.icns` artifact instead of regenerating it during wrap
* fix Telegram plugin declaration build by removing a dead mention-context argument
* fix macOS keychain unit-test skips for authorization-denied runners
* pin active LLM plugin priority so selected providers win runtime model resolution
* remove hidden provider failover and harden embedding retry behavior

## [0.3.0](https://github.com/Dexploarer/detour/compare/v0.2.0...v0.3.0) (2026-05-05)


### Features

* channel gateway, inbox, local llama embeddings, prod webview bundling ([3838f43](https://github.com/Dexploarer/detour/commit/3838f43))
* **pensieve:** add Notes/Knowledge scopes + multi-table memory search + template injection hook ([6a2c268](https://github.com/Dexploarer/detour/commit/6a2c268))
* **pensieve:** add Tasks view + trajectory export endpoint ([abc1160](https://github.com/Dexploarer/detour/commit/abc1160))
* **pensieve:** memory + relationship + graph browser, plus separate Activity window ([baadd5e](https://github.com/Dexploarer/detour/commit/baadd5e))


### Bug Fixes

* **ci:** use @ts-ignore (not @ts-expect-error) for dynamic eliza imports ([1346108](https://github.com/Dexploarer/detour/commit/1346108))
* **ci:** suppress @ts-expect-error on dynamic eliza channel imports ([ee09ab5](https://github.com/Dexploarer/detour/commit/ee09ab5))


### Code Refactoring

* **activity:** rename Pensieve* types to Activity* across log/runtime/tasks/trajectory services ([cce90f6](https://github.com/Dexploarer/detour/commit/cce90f6))
* move operational services from pensieve/ to activity/ ([3e265b8](https://github.com/Dexploarer/detour/commit/3e265b8))

## [0.2.0](https://github.com/Dexploarer/detour/compare/v0.1.1...v0.2.0) (2026-05-04)


### Features

* **pensieve:** memory + relationship + graph browser, plus separate Activity window ([baadd5e](https://github.com/Dexploarer/detour/commit/baadd5e))

## [0.1.1](https://github.com/Dexploarer/detour/compare/v0.1.0...v0.1.1) (2026-05-04)


### Bug Fixes

* augment PATH so bundled .app finds homebrew binaries (op, bw, brew, npm) ([0b321cd](https://github.com/Dexploarer/detour/commit/0b321cd))

## [0.1.0](https://github.com/Dexploarer/detour/compare/v0.0.1...v0.1.0) (2026-05-04)


### Features

* ship Detour app — codex/vault plugins, configuration UI, OS perms, icons, tests, CI ([346d3aa](https://github.com/Dexploarer/detour/commit/346d3aa9d67425887d6b936e34a1c2eb1806a18e))
