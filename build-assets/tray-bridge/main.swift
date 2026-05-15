/*
 * DetourTray — faceless Swift tray companion that owns the menu-bar
 * status item with a real NSMenu + custom NSView items (like
 * MeetingBar / the macOS Battery menu).
 *
 * Architecture:
 *   - Polls Detour's HTTP at 127.0.0.1:2138/api/tray-state every 4s.
 *   - Builds NSMenu fresh each tick with rich rows: status header
 *     with an inline NSProgressIndicator for memory budget, color-
 *     coded chips for the three local-AI tiers, ✓ checkmarks on the
 *     active provider, recent-activity submenu.
 *   - Click any item → opens detour://… via NSWorkspace which the
 *     Bun-side url-scheme feature routes.
 *   - LSUIElement = YES → no Dock icon, no app menu, no windows.
 *   - Auto-exits when Detour's HTTP stops responding for >30s, so
 *     we don't leak a tray after a Detour crash.
 *
 * Detour spawns this on boot (see src/bun/features/tray-bridge/) and
 * disables Electrobun's tray so only one icon shows in the menu bar.
 */

import Cocoa

// MARK: - Config

private let POLL_INTERVAL: TimeInterval = 4.0
private let STATE_URL = URL(string: "http://127.0.0.1:2138/api/tray-state")!
private let HEALTH_URL = URL(string: "http://127.0.0.1:2138/api/health")!
private let MAX_UNREACHABLE_SECONDS: TimeInterval = 30

// MARK: - Snapshot model (mirrors src/shared/index.ts TraySnapshotWire)

struct TrayProvider: Decodable {
    let id: String
    let label: String
    let active: Bool
    let configured: Bool
}

struct TrayEmbed: Decodable {
    let running: Bool
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastError: String?
}

struct TrayPreset: Decodable {
    let id: String
    let label: String
    let approxLiveRamGB: Double
    let approxDiskGB: Double
    let downloaded: Bool
}

struct TrayLocalChat: Decodable {
    let enabled: Bool
    let running: Bool
    let preset: String?
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastArbiterRefusal: String?
    let presets: [TrayPreset]
}

struct TrayCompanion: Decodable {
    let enabled: Bool
    let running: Bool
    let preset: String?
    let sharedWithLocalChat: Bool
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastArbiterRefusal: String?
    let presets: [TrayPreset]
}

struct TrayMemory: Decodable {
    let totalGB: Double
    let headroomGB: Double
    let budgetGB: Double
    let usedGB: Double
}

struct TrayTrajectory: Decodable {
    let id: String
    let source: String?
    let startTime: Double?
    let status: String?
}

struct TraySnapshot: Decodable {
    let activeProviderId: String?
    let providers: [TrayProvider]
    let embed: TrayEmbed
    let localChat: TrayLocalChat
    let companion: TrayCompanion
    let memory: TrayMemory?
    let recentTrajectories: [TrayTrajectory]
}

// MARK: - URL forwarding

private func openDetourURL(_ url: String) {
    guard let u = URL(string: url) else { return }
    NSWorkspace.shared.open(u)
}

private func percentEncode(_ value: String) -> String {
    return value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
}

// MARK: - Memory bar custom view (the "MeetingBar look")

/// Custom NSView for the menu-bar memory line. Renders:
///     RAM     ▓▓▓▓▓░░░░░ 4.2 / 10.0 GB
/// Tone shifts green → amber (≥70%) → red (≥90%).
final class MemoryBarView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let valueLabel = NSTextField(labelWithString: "")
    private let track = NSView()
    private let fill = NSView()

    init(memory: TrayMemory) {
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 36))
        autoresizingMask = [.width]

        // The OS draws menu items with internal horizontal padding;
        // we mirror it so our progress bar lines up.
        let leftPad: CGFloat = 18
        let rightPad: CGFloat = 12

        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.stringValue = "Memory"
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: leftPad, y: 18, width: 80, height: 14)
        addSubview(label)

        valueLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        valueLabel.stringValue = "\(format(memory.usedGB)) / \(format(memory.budgetGB)) GB"
        valueLabel.textColor = .tertiaryLabelColor
        valueLabel.alignment = .right
        valueLabel.frame = NSRect(x: bounds.width - rightPad - 140, y: 18, width: 140, height: 14)
        valueLabel.autoresizingMask = [.minXMargin]
        addSubview(valueLabel)

        // Track.
        track.wantsLayer = true
        track.layer?.backgroundColor = NSColor.tertiaryLabelColor.withAlphaComponent(0.25).cgColor
        track.layer?.cornerRadius = 2
        let trackWidth = bounds.width - leftPad - rightPad
        track.frame = NSRect(x: leftPad, y: 8, width: trackWidth, height: 4)
        track.autoresizingMask = [.width]
        addSubview(track)

        // Fill.
        let pct = memory.budgetGB > 0 ? min(1.0, memory.usedGB / memory.budgetGB) : 0
        fill.wantsLayer = true
        let tone: NSColor =
            pct >= 0.9
                ? NSColor(srgbRed: 1.0, green: 0.27, blue: 0.23, alpha: 1) // red
                : pct >= 0.7
                ? NSColor(srgbRed: 1.0, green: 0.62, blue: 0.04, alpha: 1) // amber
                : NSColor(srgbRed: 0.19, green: 0.82, blue: 0.35, alpha: 1) // green
        fill.layer?.backgroundColor = tone.cgColor
        fill.layer?.cornerRadius = 2
        fill.frame = NSRect(
            x: leftPad,
            y: 8,
            width: max(2, trackWidth * pct),
            height: 4,
        )
        addSubview(fill)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    private func format(_ gb: Double) -> String {
        return String(format: "%.1f", gb)
    }
}

/// Status header custom view — "● Provider + summary" line with a
/// colored dot. Sits at the top of the menu, non-clickable.
final class StatusHeaderView: NSView {
    init(provider: String?, embedRunning: Bool) {
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 28))
        autoresizingMask = [.width]
        let leftPad: CGFloat = 18

        let dot = NSView(frame: NSRect(x: leftPad, y: 10, width: 8, height: 8))
        dot.wantsLayer = true
        let onColor = NSColor(srgbRed: 0.19, green: 0.82, blue: 0.35, alpha: 1)
        let offColor = NSColor.tertiaryLabelColor
        dot.layer?.backgroundColor = (provider != nil ? onColor : offColor).cgColor
        dot.layer?.cornerRadius = 4
        addSubview(dot)

        let label = NSTextField(labelWithString: "")
        label.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        label.stringValue = provider.map { "Detour: \($0)" } ?? "Detour: no provider"
        label.textColor = .labelColor
        label.frame = NSRect(x: leftPad + 14, y: 7, width: 220, height: 14)
        label.autoresizingMask = [.width]
        addSubview(label)

        if !embedRunning {
            let warn = NSTextField(labelWithString: "embeddings starting…")
            warn.font = NSFont.systemFont(ofSize: 10, weight: .regular)
            warn.textColor = NSColor(srgbRed: 1.0, green: 0.62, blue: 0.04, alpha: 1)
            warn.frame = NSRect(x: leftPad + 14, y: -4, width: 220, height: 11)
            addSubview(warn)
        }
    }

    required init?(coder: NSCoder) {
        return nil
    }
}

// MARK: - Menu builder

final class TrayController: NSObject {
    private let statusItem: NSStatusItem
    private var snapshot: TraySnapshot?
    private var lastReachableAt: Date = Date()
    private var pollTimer: Timer?

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        configureButton()
        rebuildMenu()
        startPolling()
    }

    private func configureButton() {
        guard let button = statusItem.button else { return }
        // Template image — auto-tints for light/dark menu bar. We
        // render a simple "D" since Detour's PNG template lives in
        // the main bundle and we don't have access to it from this
        // companion. Apple's symbols give us a nicer fallback.
        if let img = NSImage(systemSymbolName: "puzzlepiece.fill", accessibilityDescription: "Detour") {
            img.isTemplate = true
            button.image = img
        } else {
            button.title = "D"
        }
    }

    private func startPolling() {
        pollOnce()
        pollTimer = Timer.scheduledTimer(withTimeInterval: POLL_INTERVAL, repeats: true) { [weak self] _ in
            self?.pollOnce()
        }
        if let t = pollTimer {
            RunLoop.main.add(t, forMode: .common)
        }
    }

    private func pollOnce() {
        var req = URLRequest(url: STATE_URL, timeoutInterval: 2.0)
        req.httpMethod = "GET"
        let task = URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            guard let self else { return }
            if let data, err == nil {
                do {
                    let snap = try JSONDecoder().decode(TraySnapshot.self, from: data)
                    DispatchQueue.main.async {
                        self.snapshot = snap
                        self.lastReachableAt = Date()
                        self.rebuildMenu()
                    }
                } catch {
                    NSLog("[DetourTray] decode failed: \(error)")
                }
            } else {
                // Detour unreachable. If it stays down too long, exit
                // so a stale tray doesn't outlive its parent.
                if Date().timeIntervalSince(self.lastReachableAt) > MAX_UNREACHABLE_SECONDS {
                    NSLog("[DetourTray] Detour unreachable for >\(MAX_UNREACHABLE_SECONDS)s, exiting")
                    DispatchQueue.main.async { exit(0) }
                }
            }
        }
        task.resume()
    }

    // MARK: Menu construction

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        // Status header
        let providerName = snapshot.flatMap { snap in
            snap.providers.first(where: { $0.id == snap.activeProviderId })?.label
        }
        let header = NSMenuItem()
        header.view = StatusHeaderView(
            provider: providerName,
            embedRunning: snapshot?.embed.running ?? false,
        )
        header.isEnabled = false
        menu.addItem(header)

        // Memory bar
        if let mem = snapshot?.memory {
            let memItem = NSMenuItem()
            memItem.view = MemoryBarView(memory: mem)
            memItem.isEnabled = false
            menu.addItem(memItem)
        }

        menu.addItem(NSMenuItem.separator())

        // Provider submenu
        let providers = snapshot?.providers ?? []
        if !providers.isEmpty {
            let providerItem = NSMenuItem(title: "Provider", action: nil, keyEquivalent: "")
            let providerMenu = NSMenu()
            providerMenu.autoenablesItems = false
            for p in providers {
                let item = NSMenuItem(
                    title: p.label,
                    action: #selector(switchProvider(_:)),
                    keyEquivalent: "",
                )
                item.target = self
                item.representedObject = p.id
                item.state = p.active ? .on : .off
                item.isEnabled = p.configured
                if !p.configured {
                    item.toolTip = "Not configured — add a key or sign in via Settings"
                }
                providerMenu.addItem(item)
            }
            providerItem.submenu = providerMenu
            menu.addItem(providerItem)
        }

        // Local AI submenu — clickable. Each tier has its current state
        // shown as a disabled status row, then start/stop + a preset
        // picker. Picking a preset that isn't downloaded triggers an
        // automatic download via llama-server's HF fetch path.
        let localItem = NSMenuItem(title: "Local AI", action: nil, keyEquivalent: "")
        let localMenu = NSMenu()
        localMenu.autoenablesItems = false

        // Embed (always-on; can't be stopped via tray since it's required
        // for the agent to work). Show download progress if active.
        let embedStatus = NSMenuItem(title: embedLabel(), action: nil, keyEquivalent: "")
        embedStatus.isEnabled = false
        embedStatus.state = (snapshot?.embed.running ?? false) ? .on : .off
        localMenu.addItem(embedStatus)

        localMenu.addItem(NSMenuItem.separator())

        // Chat tier — status, start/stop, preset picker
        let chat = snapshot?.localChat
        let chatStatusItem = NSMenuItem(title: chatLabel(chat), action: nil, keyEquivalent: "")
        chatStatusItem.isEnabled = false
        chatStatusItem.state = (chat?.running ?? false) ? .on : .off
        localMenu.addItem(chatStatusItem)
        if let refusal = chat?.lastArbiterRefusal, !refusal.isEmpty {
            let refusalItem = NSMenuItem(title: "⚠ RAM: \(truncate(refusal, 60))", action: nil, keyEquivalent: "")
            refusalItem.isEnabled = false
            localMenu.addItem(refusalItem)
        }
        if let dl = chat?.downloadPercent, dl < 100 {
            let dlItem = NSMenuItem(title: "↓ downloading \(dl)%", action: nil, keyEquivalent: "")
            dlItem.isEnabled = false
            localMenu.addItem(dlItem)
        }
        if chat?.running == true {
            let stopItem = NSMenuItem(title: "Stop Chat", action: #selector(stopChat), keyEquivalent: "")
            stopItem.target = self
            localMenu.addItem(stopItem)
        } else {
            // "Start with…" submenu of presets. Clicking starts (and
            // downloads if needed) the chosen model.
            let startItem = NSMenuItem(title: "Start Chat with…", action: nil, keyEquivalent: "")
            startItem.submenu = buildPresetMenu(
                presets: chat?.presets ?? [],
                action: #selector(startChatWithPreset(_:)),
                memoryBudget: snapshot?.memory,
            )
            localMenu.addItem(startItem)
        }

        localMenu.addItem(NSMenuItem.separator())

        // Companion tier — same shape as chat
        let comp = snapshot?.companion
        let compStatusItem = NSMenuItem(title: companionLabel(comp), action: nil, keyEquivalent: "")
        compStatusItem.isEnabled = false
        compStatusItem.state = (comp?.running ?? false) ? .on : .off
        localMenu.addItem(compStatusItem)
        if let refusal = comp?.lastArbiterRefusal, !refusal.isEmpty {
            let refusalItem = NSMenuItem(title: "⚠ RAM: \(truncate(refusal, 60))", action: nil, keyEquivalent: "")
            refusalItem.isEnabled = false
            localMenu.addItem(refusalItem)
        }
        if let dl = comp?.downloadPercent, dl < 100 {
            let dlItem = NSMenuItem(title: "↓ downloading \(dl)%", action: nil, keyEquivalent: "")
            dlItem.isEnabled = false
            localMenu.addItem(dlItem)
        }
        if comp?.running == true {
            let stopItem = NSMenuItem(title: "Stop Companion", action: #selector(stopCompanion), keyEquivalent: "")
            stopItem.target = self
            localMenu.addItem(stopItem)
        } else {
            let startItem = NSMenuItem(title: "Start Companion with…", action: nil, keyEquivalent: "")
            startItem.submenu = buildPresetMenu(
                presets: comp?.presets ?? [],
                action: #selector(startCompanionWithPreset(_:)),
                memoryBudget: snapshot?.memory,
            )
            localMenu.addItem(startItem)
        }

        localMenu.addItem(NSMenuItem.separator())
        let openSettings = NSMenuItem(
            title: "Configure…",
            action: #selector(openSettingPath(_:)),
            keyEquivalent: "",
        )
        openSettings.target = self
        openSettings.representedObject = "configuration:local-ai"
        localMenu.addItem(openSettings)

        localItem.submenu = localMenu
        menu.addItem(localItem)

        menu.addItem(NSMenuItem.separator())

        // Window quick-actions (always present, regardless of slot prefs —
        // slots are for the popover; the native menu shows everything).
        for (target, label, shortcut) in [
            ("chat", "Open Chat", "c"),
            ("pensieve", "Open Pensieve", "p"),
            ("activity", "Open Activity", "a"),
            ("browser", "Open Browser", "b"),
            ("gallery", "Open Gallery", "g"),
            ("settings", "Settings…", ","),
        ] {
            let item = NSMenuItem(
                title: label,
                action: #selector(openWindow(_:)),
                keyEquivalent: shortcut,
            )
            item.target = self
            item.representedObject = target
            item.keyEquivalentModifierMask = [.command, .shift]
            menu.addItem(item)
        }

        // Recent activity submenu
        let recent = snapshot?.recentTrajectories ?? []
        if !recent.isEmpty {
            menu.addItem(NSMenuItem.separator())
            let recentItem = NSMenuItem(title: "Recent activity", action: nil, keyEquivalent: "")
            let recentMenu = NSMenu()
            for t in recent.prefix(5) {
                let title = trajectoryTitle(t)
                let item = NSMenuItem(
                    title: title,
                    action: #selector(openActivity),
                    keyEquivalent: "",
                )
                item.target = self
                recentMenu.addItem(item)
            }
            recentItem.submenu = recentMenu
            menu.addItem(recentItem)
        }

        menu.addItem(NSMenuItem.separator())
        let aboutItem = NSMenuItem(title: "About Detour", action: #selector(openAbout), keyEquivalent: "")
        aboutItem.target = self
        menu.addItem(aboutItem)
        let quitItem = NSMenuItem(title: "Quit Detour", action: #selector(quitDetour), keyEquivalent: "q")
        quitItem.target = self
        quitItem.keyEquivalentModifierMask = [.command]
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func embedLabel() -> String {
        guard let snap = snapshot else { return "Embed: …" }
        if let pct = snap.embed.downloadPercent, pct < 100 {
            return "Embed: downloading \(pct)%"
        }
        if snap.embed.running { return "Embed: running" }
        if let err = snap.embed.lastError, !err.isEmpty { return "Embed: error" }
        return "Embed: stopped"
    }

    private func chatLabel(_ chat: TrayLocalChat?) -> String {
        guard let chat else { return "Chat: …" }
        if chat.running { return "Chat: \(chat.preset ?? "running")" }
        if chat.enabled { return "Chat: enabled (not running)" }
        return "Chat: off"
    }

    private func companionLabel(_ comp: TrayCompanion?) -> String {
        guard let comp else { return "Companion: …" }
        if comp.sharedWithLocalChat { return "Companion: shared with chat" }
        if comp.running { return "Companion: \(comp.preset ?? "running")" }
        if comp.enabled { return "Companion: enabled (not running)" }
        return "Companion: off"
    }

    private func trajectoryTitle(_ t: TrayTrajectory) -> String {
        let src = t.source ?? "turn"
        let when: String
        if let ts = t.startTime {
            let delta = Date().timeIntervalSince1970 - (ts / 1000)
            if delta < 60 { when = "just now" }
            else if delta < 3600 { when = "\(Int(delta / 60))m ago" }
            else if delta < 86400 { when = "\(Int(delta / 3600))h ago" }
            else { when = "\(Int(delta / 86400))d ago" }
        } else {
            when = ""
        }
        return "\(src) \(when)".trimmingCharacters(in: .whitespaces)
    }

    // MARK: Actions

    @objc func switchProvider(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        openDetourURL("detour://action?name=PROVIDER_SET_ACTIVE&id=\(percentEncode(id))")
    }

    @objc func openWindow(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? String else { return }
        openDetourURL("detour://window?target=\(percentEncode(target))")
    }

    @objc func openSettingPath(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        openDetourURL("detour://settings?tab=\(percentEncode(path))")
    }

    @objc func openActivity() {
        openDetourURL("detour://window?target=activity")
    }

    @objc func openAbout() {
        openDetourURL("detour://settings?tab=configuration:appearance")
    }

    @objc func quitDetour() {
        // Trigger the bun-side appQuit RPC path which gracefully runs
        // the before-quit hooks. Detour's launcher exits; this tray
        // companion notices Detour is unreachable and exits itself
        // after MAX_UNREACHABLE_SECONDS.
        openDetourURL("detour://action?name=APP_QUIT")
        // Belt-and-suspenders: exit our own process after a beat so
        // the icon disappears even if Detour was slow.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { exit(0) }
    }

    // ── Local AI controls ─────────────────────────────────────────────

    @objc func stopChat() {
        openDetourURL("detour://localchat/stop")
        // Trigger an immediate poll so the menu reflects the new state
        // on the next render without waiting for the regular 4s tick.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollOnce() }
    }

    @objc func startChatWithPreset(_ sender: NSMenuItem) {
        guard let preset = sender.representedObject as? String else { return }
        openDetourURL("detour://localchat/start?preset=\(percentEncode(preset))")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollOnce() }
    }

    @objc func stopCompanion() {
        openDetourURL("detour://companion/stop")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollOnce() }
    }

    @objc func startCompanionWithPreset(_ sender: NSMenuItem) {
        guard let preset = sender.representedObject as? String else { return }
        openDetourURL("detour://companion/start?preset=\(percentEncode(preset))")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollOnce() }
    }

    /// Build a submenu of presets with one item per preset. Each item
    /// is annotated with disk + RAM hints; if `memoryBudget` is
    /// provided, presets that would over-budget are flagged.
    private func buildPresetMenu(
        presets: [TrayPreset],
        action: Selector,
        memoryBudget: TrayMemory?,
    ) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        if presets.isEmpty {
            let empty = NSMenuItem(title: "No presets available", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return menu
        }
        for p in presets {
            let ramStr = String(format: "%.1f GB", p.approxLiveRamGB)
            let diskStr = p.approxDiskGB >= 1.0
                ? String(format: "%.1f GB on disk", p.approxDiskGB)
                : String(format: "%d MB on disk", Int(p.approxDiskGB * 1024))
            let mark: String
            if p.downloaded {
                mark = "✓ downloaded"
            } else {
                mark = "↓ will download"
            }
            // Approximate fit: if current used + this preset's RAM
            // exceeds the budget, warn. The arbiter does the real check.
            var fitWarning = ""
            if let mem = memoryBudget {
                let projected = mem.usedGB + p.approxLiveRamGB
                if projected > mem.budgetGB {
                    fitWarning = "  ⚠ over RAM budget"
                }
            }
            let title = "\(p.label) — \(ramStr) live, \(diskStr) (\(mark))\(fitWarning)"
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            item.representedObject = p.id
            menu.addItem(item)
        }
        return menu
    }
}

private func truncate(_ s: String, _ n: Int) -> String {
    if s.count <= n { return s }
    return String(s.prefix(n)) + "…"
}

// MARK: - App boot

final class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: TrayController?

    func applicationDidFinishLaunching(_: Notification) {
        NSLog("[DetourTray] launching (pid=\(getpid()))")
        controller = TrayController()
    }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
