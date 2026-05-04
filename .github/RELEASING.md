# Releasing Detour

Three release channels, all driven by tags:

| Channel | Tag pattern         | Triggered by                           | What ships                                                               |
| ------- | ------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| Canary  | `canary` (rolling)  | Every push to `main`                   | Latest commit, unsigned, overwrites the rolling Canary GitHub release.   |
| Beta    | `vX.Y.Z-beta.N`     | release-please PR merge on `beta`      | Stable build flavor, marked as pre-release on GitHub.                    |
| Stable  | `vX.Y.Z`            | release-please PR merge on `main`      | Code-signed + notarized when secrets present, "Latest" on GitHub.        |

## How auto-tagging works

[`release-please`](https://github.com/googleapis/release-please) reads the
[Conventional Commits](https://www.conventionalcommits.org/) on `main` since the
last tag and proposes the next version in a PR (`chore: release X.Y.Z`). When
that PR lands:

1. release-please tags `vX.Y.Z` and creates a GitHub Release.
2. `.github/workflows/release.yml` picks up the tag, builds for `arm64` + `x64`,
   optionally code-signs, and attaches the artifacts (`.zip` + `.dmg`).

Bump rules (with `bump-minor-pre-major: true` while we're 0.x):

- `feat:` → minor bump
- `fix:` / `perf:` → patch bump
- `feat!:` or `BREAKING CHANGE:` footer → minor bump (will become major after 1.0)
- Other types (`chore:`, `docs:`, `test:`, `refactor:`, `style:`, `ci:`,
  `build:`) → no version bump but appear in the changelog

## Beta line

Push commits to a `beta` branch and release-please will open separate PRs that
tag `vX.Y.Z-beta.N`. Use this to ship early access without disturbing stable.

## Manual rebuild

`Actions → Release → Run workflow` and pass an existing tag to rebuild that
release's artifacts (e.g. after fixing a build environment issue).

## Code signing (stable only)

Set these GitHub secrets to enable Apple Developer ID signing + notarization on
stable builds:

- `APPLE_CERT_BASE64` — base64-encoded Developer ID Application certificate (.p12)
- `APPLE_CERT_PASSWORD` — password for the .p12
- `APPLE_TEAM_ID` — 10-character team ID
- `APPLE_NOTARIZE_USER` — Apple ID
- `APPLE_NOTARIZE_PASSWORD` — app-specific password

Without these, builds still complete but ship unsigned. Users will need to
right-click → Open the first time, or remove the quarantine attribute:
```bash
xattr -d com.apple.quarantine /Applications/Detour.app
```

## Conventional commit cheat sheet

```
feat(scope): add a new feature        → minor bump
fix(scope): patch a bug               → patch bump
feat(scope)!: change behavior         → minor bump (major post-1.0)
chore: housekeeping                   → no bump
docs: update README                   → no bump
test: add tests                       → no bump
refactor: shuffle code                → no bump
ci: tweak workflow                    → no bump
build: change build pipeline          → no bump
```
