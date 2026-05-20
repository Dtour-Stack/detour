/*
 * NativeSkills — read the elizaOS skill catalog (SKILL.md files) directly
 * from disk in Swift, bypassing the HTTP roundtrip to bun's
 * /api/eval/skills.
 *
 * Same algorithm as @elizaos/skills `loadSkills()`: walk the known
 * roots, parse each SKILL.md's YAML-like frontmatter, return the
 * catalog. Result: ~200µs locally vs ~5ms via HTTP.
 *
 * Sources (in priority order — same as the bun side):
 *   1. Resources/app/eliza/packages/skills/skills/  (bundled)
 *   2. ~/.elizaos/skills/                          (user-installed)
 *   3. $ELIZAOS_BUNDLED_SKILLS_DIR / $ELIZA_STATE_DIR (env-overridable)
 *
 * Enable/disable state is persisted in ~/.detour/skill-enablement.json
 * (same path the bun side reads + writes).
 */

import Foundation

struct NativeSkill: Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let emoji: String?
    let homepage: String?
    let filePath: String
    let baseDir: String
    var enabled: Bool
}

enum NativeSkillsReader {
    /// Walk every skill root, parse SKILL.md frontmatter, merge with
    /// enablement state. Cheap enough to call on every Settings →
    /// Skills tab open (~5-10ms for ~30 skills).
    static func list() -> [NativeSkill] {
        var skills: [NativeSkill] = []
        let enablement = loadEnablement()
        for root in skillRoots() {
            for skillDir in directChildren(of: root) {
                let manifest = skillDir.appendingPathComponent("SKILL.md")
                guard FileManager.default.fileExists(atPath: manifest.path) else { continue }
                guard let parsed = parseFrontmatter(at: manifest) else { continue }
                let id = parsed.name
                skills.append(NativeSkill(
                    id: id,
                    name: parsed.name,
                    description: parsed.description,
                    emoji: parsed.emoji,
                    homepage: parsed.homepage,
                    filePath: manifest.path,
                    baseDir: skillDir.path,
                    enabled: enablement[id] ?? true,
                ))
            }
        }
        // Dedup: prefer later (user-installed > bundled) when names collide.
        var byId: [String: NativeSkill] = [:]
        for s in skills { byId[s.id] = s }
        return byId.values.sorted { $0.id.lowercased() < $1.id.lowercased() }
    }

    /// Persist a skill's enable state (matches the bun-side
    /// ~/.detour/skill-enablement.json path).
    @discardableResult
    static func setEnabled(_ id: String, enabled: Bool) -> Bool {
        var state = loadEnablement()
        state[id] = enabled
        return writeEnablement(state)
    }

    // MARK: - Internals

    private static func skillRoots() -> [URL] {
        var roots: [URL] = []
        // Bundled: Detour.app/Contents/Resources/app/eliza/packages/skills/skills/
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents")
            .appendingPathComponent("Resources")
            .appendingPathComponent("app")
            .appendingPathComponent("eliza")
            .appendingPathComponent("packages")
            .appendingPathComponent("skills")
            .appendingPathComponent("skills")
        if FileManager.default.fileExists(atPath: bundled.path) {
            roots.append(bundled)
        }
        // User-installed: ~/.elizaos/skills/
        if let home = ProcessInfo.processInfo.environment["HOME"] {
            let userSkills = URL(fileURLWithPath: home)
                .appendingPathComponent(".elizaos")
                .appendingPathComponent("skills")
            if FileManager.default.fileExists(atPath: userSkills.path) {
                roots.append(userSkills)
            }
        }
        // Env overrides — match the bun side's lookup chain.
        for envKey in ["ELIZAOS_BUNDLED_SKILLS_DIR", "ELIZA_STATE_DIR"] {
            if let path = ProcessInfo.processInfo.environment[envKey],
               !path.isEmpty,
               FileManager.default.fileExists(atPath: path) {
                roots.append(URL(fileURLWithPath: path))
            }
        }
        return roots
    }

    private static func directChildren(of root: URL) -> [URL] {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles],
        ) else { return [] }
        return entries.filter { url in
            (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }
    }

    /// Parse the YAML-like frontmatter at the top of a SKILL.md.
    /// Handles the elizaOS format: `---` opener, `key: value` lines,
    /// then a `metadata: { ... }` JSON-ish blob that may include
    /// `otto: { emoji: "…" }`. We only need name/description/emoji/
    /// homepage; everything else is tolerated and ignored.
    private static func parseFrontmatter(at url: URL) -> ParsedFrontmatter? {
        guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        guard raw.hasPrefix("---") else {
            // No frontmatter — synthesize one from the directory name.
            return ParsedFrontmatter(name: url.deletingLastPathComponent().lastPathComponent,
                                     description: "",
                                     emoji: nil,
                                     homepage: nil)
        }
        // Find the closing `---` separator.
        let rest = String(raw.dropFirst(3))
        guard let closingRange = rest.range(of: "\n---") else { return nil }
        let frontmatter = String(rest[rest.startIndex..<closingRange.lowerBound])
        var name = url.deletingLastPathComponent().lastPathComponent
        var description = ""
        var homepage: String? = nil
        var emoji: String? = nil
        for raw in frontmatter.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("name:") {
                name = String(line.dropFirst("name:".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("description:") {
                description = String(line.dropFirst("description:".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("homepage:") {
                homepage = String(line.dropFirst("homepage:".count)).trimmingCharacters(in: .whitespaces)
            }
        }
        // Best-effort emoji extraction — scan for `"emoji": "…"` in the
        // metadata block. The block isn't strict JSON; regex over the
        // whole frontmatter is more tolerant.
        if let range = frontmatter.range(of: #""emoji"\s*:\s*""#, options: .regularExpression) {
            let after = frontmatter[range.upperBound...]
            if let endQuote = after.firstIndex(of: "\"") {
                emoji = String(after[after.startIndex..<endQuote])
            }
        }
        return ParsedFrontmatter(name: name, description: description, emoji: emoji, homepage: homepage)
    }

    private struct ParsedFrontmatter {
        let name: String
        let description: String
        let emoji: String?
        let homepage: String?
    }

    // MARK: - Enablement persistence

    private static var enablementPath: URL {
        URL(fileURLWithPath: NSString(string: "~/.detour/skill-enablement.json").expandingTildeInPath)
    }

    private static func loadEnablement() -> [String: Bool] {
        guard let data = try? Data(contentsOf: enablementPath),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        var out: [String: Bool] = [:]
        for (k, v) in raw {
            if let b = v as? Bool { out[k] = b }
        }
        return out
    }

    private static func writeEnablement(_ state: [String: Bool]) -> Bool {
        let dir = enablementPath.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted]) else {
            return false
        }
        return (try? data.write(to: enablementPath)) != nil
    }
}
