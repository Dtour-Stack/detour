/*
 * TrayController — owns the menu-bar NSStatusItem in-process, ported
 * from build-assets/tray-bridge/main.swift. Polls Bun at
 * 127.0.0.1:2138/api/tray-state and rebuilds the NSMenu on every tick.
 *
 * Differences vs the standalone bridge:
 *   - No AppDelegate / RunLoop boot (Swiftun's AppDelegate hosts us).
 *   - On Detour unreachable, we just leave the menu blank — the parent
 *     process IS Detour, so "Detour gone" means we're terminating too.
 */

import Cocoa
import SwiftUI

private let POLL_INTERVAL: TimeInterval = 4.0
private let STATE_URL = URL(string: "http://127.0.0.1:2138/api/tray-state")!

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

struct TrayRoutingOption: Decodable {
    let id: String
    let label: String
    let kind: String          // "local" | "cloud"
    let available: Bool
}

struct TrayRoutingEntry: Decodable {
    let type: String          // e.g. "IMAGE", "TRANSCRIPTION"
    let label: String
    let selected: String
    let options: [TrayRoutingOption]
}

struct TraySnapshot: Decodable {
    let activeProviderId: String?
    let providers: [TrayProvider]
    let embed: TrayEmbed
    let localChat: TrayLocalChat
    let companion: TrayCompanion
    let memory: TrayMemory?
    let recentTrajectories: [TrayTrajectory]
    let modelRouting: [TrayRoutingEntry]?
}

/// In-process detour:// dispatch. POSTs to bun's /api/url-scheme/dispatch
/// so the URL is handled by THIS process — bypasses LaunchServices,
/// which may still resolve detour:// to a stale Electrobun bundle
/// during the cutover. Falls back to NSWorkspace.open only if the local
/// dispatch endpoint isn't reachable yet (e.g. bun still booting).
private func openDetourURL(_ url: String) {
    guard let _ = URL(string: url) else { return }
    let dispatchURL = URL(string: "http://127.0.0.1:2138/api/url-scheme/dispatch")!
    var req = URLRequest(url: dispatchURL, timeoutInterval: 3.0)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let body = try? JSONSerialization.data(withJSONObject: ["url": url])
    req.httpBody = body
    let task = URLSession.shared.dataTask(with: req) { _, response, _ in
        if let http = response as? HTTPURLResponse, http.statusCode == 200 { return }
        if let u = URL(string: url) {
            DispatchQueue.main.async { NSWorkspace.shared.open(u) }
        }
    }
    task.resume()
}

private func percentEncode(_ value: String) -> String {
    return value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
}

final class MemoryBarView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let valueLabel = NSTextField(labelWithString: "")
    private let track = NSView()
    private let fill = NSView()

    init(memory: TrayMemory) {
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 36))
        autoresizingMask = [.width]
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
        track.wantsLayer = true
        track.layer?.backgroundColor = NSColor.tertiaryLabelColor.withAlphaComponent(0.25).cgColor
        track.layer?.cornerRadius = 2
        let trackWidth = bounds.width - leftPad - rightPad
        track.frame = NSRect(x: leftPad, y: 8, width: trackWidth, height: 4)
        track.autoresizingMask = [.width]
        addSubview(track)
        let pct = memory.budgetGB > 0 ? min(1.0, memory.usedGB / memory.budgetGB) : 0
        fill.wantsLayer = true
        let tone: NSColor =
            pct >= 0.9
                ? NSColor(srgbRed: 1.0, green: 0.27, blue: 0.23, alpha: 1)
                : pct >= 0.7
                ? NSColor(srgbRed: 1.0, green: 0.62, blue: 0.04, alpha: 1)
                : NSColor(srgbRed: 0.19, green: 0.82, blue: 0.35, alpha: 1)
        fill.layer?.backgroundColor = tone.cgColor
        fill.layer?.cornerRadius = 2
        fill.frame = NSRect(x: leftPad, y: 8, width: max(2, trackWidth * pct), height: 4)
        addSubview(fill)
    }

    required init?(coder: NSCoder) { return nil }

    private func format(_ gb: Double) -> String { String(format: "%.1f", gb) }
}

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
    required init?(coder: NSCoder) { return nil }
}

@MainActor
final class TrayController: NSObject, NSMenuDelegate {
    static weak var shared: TrayController?

    private let statusItem: NSStatusItem
    private var snapshot: TraySnapshot?
    private var pollTimer: Timer?
    private var unreadCount: Int = 0

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        TrayController.shared = self
        configureButton()
        rebuildMenu()
        startPolling()
    }

    /// Update the menu-bar icon to reflect the unread agent-event count.
    /// We don't have a true badge on NSStatusItem, so we redraw the
    /// icon with the count appended next to the symbol when >0.
    func setUnread(_ count: Int) {
        unreadCount = count
        configureButton()
    }

    /// Force the menu to rebuild — called when the user toggles the
    /// "Status header / Local AI / Recent activity" preferences in
    /// Settings → Appearance → Tray.
    func rebuild() {
        rebuildMenu()
    }

    func menuWillOpen(_ menu: NSMenu) {
        // Clicking the menu == acknowledging — clear the badge.
        NotificationManager.shared.acknowledge()
    }

    private func configureButton() {
        guard let button = statusItem.button else { return }
        // Prefer the brand squirrel from Resources/AppIcon.png. The
        // source PNG has a solid white background (no alpha) — used
        // as-is with isTemplate=true the OS renders a solid black
        // square because every pixel is opaque. Punch the white
        // background to transparent first, then template-render so it
        // tints for light/dark menus.
        if let iconURL = NotificationManager.appIconURL(),
           let raw = NSImage(contentsOf: iconURL),
           let masked = TrayController.whiteToAlpha(raw) {
            let target = NSSize(width: 18, height: 18)
            let resized = NSImage(size: target)
            resized.lockFocus()
            masked.draw(in: NSRect(origin: .zero, size: target),
                        from: NSRect(origin: .zero, size: masked.size),
                        operation: .sourceOver, fraction: 1.0)
            resized.unlockFocus()
            resized.isTemplate = true
            button.image = resized
        } else if let img = NSImage(systemSymbolName: "puzzlepiece.fill", accessibilityDescription: "Detour") {
            img.isTemplate = true
            button.image = img
        } else {
            button.title = "D"
            button.image = nil
        }
        // Show " · N" next to the icon when there are unread agent
        // events. The dot is a single text glyph so it sits flush with
        // the template image instead of resizing the menu-bar item.
        if unreadCount > 0 {
            button.title = " \(unreadCount)"
            button.imagePosition = .imageLeft
        } else {
            button.title = ""
            button.imagePosition = .imageOnly
        }
    }

    private func startPolling() {
        // Push-based now: subscribe to bun's `tray.state` RPC
        // notification. Bun diffs the snapshot every 4s and only
        // emits on change. Eliminates the 15-HTTP-req/min poll.
        RPCClient.shared.onNotification("event.tray.state") { [weak self] params in
            guard let self else { return }
            guard let dict = params as? [String: Any] else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
            if let snap = try? JSONDecoder().decode(TraySnapshot.self, from: data) {
                Task { @MainActor in
                    self.snapshot = snap
                    self.rebuildMenu()
                }
            }
        }
        // One-shot initial fetch so the menu has state before the first
        // 4s-emit. After that, push takes over and the local timer is
        // never re-armed.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            await self.fetchInitialSnapshot()
        }
    }

    /// Bootstrap fetch via RPC `tray.snapshot` so the menu paints once
    /// at startup. Subsequent updates arrive as RPC notifications.
    private func fetchInitialSnapshot() async {
        do {
            let data = try await RPCClient.shared.call("tray.snapshot")
            if let snap = try? JSONDecoder().decode(TraySnapshot.self, from: data) {
                self.snapshot = snap
                self.rebuildMenu()
            }
        } catch {
            // First call often races bun's startup; the RPC client
            // reconnects automatically. The push subscription will
            // deliver the next update either way.
            NSLog("[TrayController] initial snapshot fetch failed: \(error.localizedDescription)")
        }
    }

    /// Kept for back-compat: anything that calls pollOnce() now just
    /// triggers a one-shot RPC fetch. The 4s timer is dead.
    private func pollOnce() {
        Task { @MainActor in await self.fetchInitialSnapshot() }
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        // Pull the Appearance → Tray toggles so this rebuild honors
        // them. UserDefaults values default to true (toggles ship "on").
        let defaults = UserDefaults.standard
        let showHeader = defaults.object(forKey: "detour.tray.showProviderDot") as? Bool ?? true
        let showLocalAI = defaults.object(forKey: "detour.tray.showLocalAI") as? Bool ?? true
        let showRecent = defaults.object(forKey: "detour.tray.showRecent") as? Bool ?? true

        if showHeader {
            let providerName = snapshot.flatMap { snap in
                snap.providers.first(where: { $0.id == snap.activeProviderId })?.label
            }
            let header = NSMenuItem()
            let headerView = NSHostingView(rootView: TrayHeaderSwiftUIView(
                provider: providerName,
                embedRunning: snapshot?.embed.running ?? false,
            ))
            headerView.frame = NSRect(x: 0, y: 0, width: 280, height: 40)
            headerView.autoresizingMask = [.width]
            header.view = headerView
            header.isEnabled = false
            menu.addItem(header)

            if let mem = snapshot?.memory {
                let memItem = NSMenuItem()
                let memView = NSHostingView(rootView: TrayMemoryBarSwiftUIView(memory: mem))
                memView.frame = NSRect(x: 0, y: 0, width: 280, height: 44)
                memView.autoresizingMask = [.width]
                memItem.view = memView
                memItem.isEnabled = false
                menu.addItem(memItem)
            }
            menu.addItem(NSMenuItem.separator())
        }

        // Combined "AI" submenu — cloud providers + local llama tiers
        // in one place. Gated by the Appearance → Tray → Local AI
        // toggle so the user can hide it entirely.
        let providers = snapshot?.providers ?? []
        let aiItem = NSMenuItem(title: "AI", action: nil, keyEquivalent: "")
        let localMenu = NSMenu()
        localMenu.autoenablesItems = false

        // Every row in the AI submenu is clickable now — headers and
        // status lines open Settings → Models & Providers (the canonical
        // place to configure all of this), unconfigured providers open
        // the same tab so the user can paste their key.
        if !providers.isEmpty {
            let providersHeader = NSMenuItem(
                title: "Cloud chat providers",
                action: #selector(openProvidersSettings),
                keyEquivalent: "",
            )
            providersHeader.target = self
            providersHeader.toolTip = "Configure cloud providers"
            localMenu.addItem(providersHeader)
            for p in providers {
                let item = NSMenuItem(title: "  \(p.label)", action: #selector(switchProvider(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = p.id
                item.state = p.active ? .on : .off
                // Clickable even when not configured — clicking takes
                // the user to Settings → Models & Providers so they
                // can add the API key.
                item.isEnabled = true
                if !p.configured {
                    item.toolTip = "Not configured — click to open Settings and add a key"
                }
                localMenu.addItem(item)
            }
            localMenu.addItem(NSMenuItem.separator())
        }

        // Image / Video / Voice routing — each routed ModelType gets its
        // own submenu listing local + cloud options so the user can
        // pick from the tray without opening Settings.
        if let routing = snapshot?.modelRouting, !routing.isEmpty {
            for entry in routing {
                let header = NSMenuItem(
                    title: entry.label,
                    action: nil,
                    keyEquivalent: "",
                )
                header.isEnabled = false
                localMenu.addItem(header)
                for opt in entry.options {
                    let kindTag = opt.kind == "local" ? " · local" : " · cloud"
                    let badge = opt.available ? "" : " (not configured)"
                    let item = NSMenuItem(
                        title: "  \(opt.label)\(kindTag)\(badge)",
                        action: #selector(setRoutingProvider(_:)),
                        keyEquivalent: "",
                    )
                    item.target = self
                    item.representedObject = "\(entry.type)::\(opt.id)"
                    item.state = (opt.id == entry.selected) ? NSControl.StateValue.on : NSControl.StateValue.off
                    item.toolTip = opt.available ? nil : "Not yet available — click to open Settings"
                    localMenu.addItem(item)
                }
                localMenu.addItem(NSMenuItem.separator())
            }
        }

        let localHeader = NSMenuItem(
            title: "Local llama",
            action: #selector(openProvidersSettings),
            keyEquivalent: "",
        )
        localHeader.target = self
        localHeader.toolTip = "Configure local llama tiers"
        localMenu.addItem(localHeader)

        let embedStatus = NSMenuItem(
            title: "  \(embedLabel())",
            action: #selector(openProvidersSettings),
            keyEquivalent: "",
        )
        embedStatus.target = self
        embedStatus.state = (snapshot?.embed.running ?? false) ? .on : .off
        localMenu.addItem(embedStatus)
        localMenu.addItem(NSMenuItem.separator())

        let chat = snapshot?.localChat
        let chatStatusItem = NSMenuItem(
            title: chatLabel(chat),
            action: #selector(openProvidersSettings),
            keyEquivalent: "",
        )
        chatStatusItem.target = self
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
            let startItem = NSMenuItem(title: "Start Chat with…", action: nil, keyEquivalent: "")
            startItem.submenu = buildPresetMenu(presets: chat?.presets ?? [], action: #selector(startChatWithPreset(_:)), memoryBudget: snapshot?.memory)
            localMenu.addItem(startItem)
        }
        localMenu.addItem(NSMenuItem.separator())

        let comp = snapshot?.companion
        let compStatusItem = NSMenuItem(
            title: companionLabel(comp),
            action: #selector(openProvidersSettings),
            keyEquivalent: "",
        )
        compStatusItem.target = self
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
            startItem.submenu = buildPresetMenu(presets: comp?.presets ?? [], action: #selector(startCompanionWithPreset(_:)), memoryBudget: snapshot?.memory)
            localMenu.addItem(startItem)
        }

        localMenu.addItem(NSMenuItem.separator())
        let openSettings = NSMenuItem(title: "Configure…", action: #selector(openSettingPath(_:)), keyEquivalent: "")
        openSettings.target = self
        openSettings.representedObject = "configuration:local-ai"
        localMenu.addItem(openSettings)

        aiItem.submenu = localMenu
        if showLocalAI {
            menu.addItem(aiItem)
            menu.addItem(NSMenuItem.separator())
        }

        for (target, label, shortcut) in [
            ("chat", "Open Chat", "c"),
            ("pensieve", "Open Pensieve", "p"),
            ("activity", "Open Activity", "a"),
            ("browser", "Open Browser", "b"),
            ("gallery", "Open Gallery", "g"),
            ("workspace", "Open Workspace", "w"),
            // ⌘⌃P also toggles via the global hotkey (see
            // GlobalHotKeys.installDefaults()). The tray shortcut here
            // is ⇧⌘0 for keyboard access when the user is already in
            // a Detour window.
            ("pet", "Show Pet", "0"),
        ] {
            let item = NSMenuItem(title: label, action: #selector(openWindow(_:)), keyEquivalent: shortcut)
            item.target = self
            item.representedObject = target
            item.keyEquivalentModifierMask = [.command, .shift]
            menu.addItem(item)
        }
        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettingsWindow), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(settingsItem)

        let recent = snapshot?.recentTrajectories ?? []
        if !recent.isEmpty && showRecent {
            menu.addItem(NSMenuItem.separator())
            let recentItem = NSMenuItem(title: "Recent activity", action: nil, keyEquivalent: "")
            let recentMenu = NSMenu()
            for t in recent.prefix(5) {
                let item = NSMenuItem(title: trajectoryTitle(t), action: #selector(openActivity), keyEquivalent: "")
                item.target = self
                recentMenu.addItem(item)
            }
            recentItem.submenu = recentMenu
            menu.addItem(recentItem)
        }

        menu.addItem(NSMenuItem.separator())
        let testNotif = NSMenuItem(title: "Send test notification", action: #selector(testNotification), keyEquivalent: "")
        testNotif.target = self
        menu.addItem(testNotif)
        let aboutItem = NSMenuItem(title: "About Detour", action: #selector(openAbout), keyEquivalent: "")
        aboutItem.target = self
        menu.addItem(aboutItem)
        let quitItem = NSMenuItem(title: "Quit Detour", action: #selector(quitDetour), keyEquivalent: "q")
        quitItem.target = self
        quitItem.keyEquivalentModifierMask = [.command]
        menu.addItem(quitItem)

        menu.delegate = self
        statusItem.menu = menu
    }

    @objc func testNotification() {
        Task {
            let result = await NotificationManager.shared.sendTestNotification()
            NSLog("[tray] test notification: \(result)")
        }
    }

    private func embedLabel() -> String {
        guard let snap = snapshot else { return "Embed: …" }
        if let pct = snap.embed.downloadPercent, pct < 100 { return "Embed: downloading \(pct)%" }
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
        } else { when = "" }
        return "\(src) \(when)".trimmingCharacters(in: .whitespaces)
    }

    /// Tray-level routing setter: clicking an image/voice/STT/vision/
    /// video provider in the AI submenu fires this. `representedObject`
    /// encodes "<TYPE>::<provider-id>" so we can both validate and
    /// route to the right setting key.
    @objc func setRoutingProvider(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let sep = raw.range(of: "::") else { return }
        let type = String(raw[..<sep.lowerBound])
        let providerId = String(raw[sep.upperBound...])
        let key = "DETOUR_MODEL_\(type)_PROVIDER"
        Task { @MainActor in
            do {
                _ = try await RPCClient.shared.call("settings.set", params: [
                    "key": key, "value": providerId,
                ])
                // Re-poll so the next menu draw reflects the new pick.
                self.requestSnapshotRefresh()
            } catch {
                NSLog("[Tray] setRoutingProvider failed: \(error.localizedDescription)")
            }
        }
    }

    /// Best-effort: force a snapshot refresh after writing a setting.
    /// The push-based broadcaster will catch up within ~4s anyway, but
    /// nudging it makes the checkmark update feel instant in the menu.
    private func requestSnapshotRefresh() {
        Task { @MainActor in
            if let data = try? await RPCClient.shared.call("tray.snapshot"),
               let snap = try? JSONDecoder().decode(TraySnapshot.self, from: data) {
                self.snapshot = snap
                self.rebuild()
            }
        }
    }

    @objc func switchProvider(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        // Look up whether THIS provider is configured. If not, opening
        // Settings is more useful than firing the activate action which
        // would fail anyway. (TrayProvider's `configured` flag lives in
        // snapshot.providers — find the matching one.)
        let configured = snapshot?.providers.first(where: { $0.id == id })?.configured ?? false
        if !configured {
            WindowFactory.shared.openSettings(tab: "configuration:providers")
            return
        }
        openDetourURL("detour://action?name=PROVIDER_SET_ACTIVE&id=\(percentEncode(id))")
    }

    /// Opens Settings → Models & Providers — used by tray submenu rows
    /// that previously rendered as inert greyed headers / status lines.
    /// Everything in the AI submenu now leads SOMEWHERE useful.
    @objc func openProvidersSettings() {
        WindowFactory.shared.openSettings(tab: "configuration:providers")
    }

    @objc func openWindow(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? String else { return }
        // In-process: call WindowFactory directly. No URL roundtrip.
        WindowFactory.shared.open(target: target)
    }

    @objc func openSettingsWindow() {
        WindowFactory.shared.openSettings()
    }

    @objc func openSettingPath(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        WindowFactory.shared.openSettings(tab: path)
    }

    @objc func openActivity() {
        WindowFactory.shared.openActivity()
    }

    @objc func openAbout() {
        WindowFactory.shared.openSettings()
    }

    @objc func quitDetour() {
        NSApplication.shared.terminate(nil)
    }

    @objc func stopChat() {
        openDetourURL("detour://localchat/stop")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { Task { @MainActor in self.pollOnce() } }
    }

    @objc func startChatWithPreset(_ sender: NSMenuItem) {
        guard let preset = sender.representedObject as? String else { return }
        openDetourURL("detour://localchat/start?preset=\(percentEncode(preset))")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { Task { @MainActor in self.pollOnce() } }
    }

    @objc func stopCompanion() {
        openDetourURL("detour://companion/stop")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { Task { @MainActor in self.pollOnce() } }
    }

    @objc func startCompanionWithPreset(_ sender: NSMenuItem) {
        guard let preset = sender.representedObject as? String else { return }
        openDetourURL("detour://companion/start?preset=\(percentEncode(preset))")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { Task { @MainActor in self.pollOnce() } }
    }

    private func buildPresetMenu(presets: [TrayPreset], action: Selector, memoryBudget: TrayMemory?) -> NSMenu {
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
            let mark = p.downloaded ? "✓ downloaded" : "↓ will download"
            var fitWarning = ""
            if let mem = memoryBudget {
                let projected = mem.usedGB + p.approxLiveRamGB
                if projected > mem.budgetGB { fitWarning = "  ⚠ over RAM budget" }
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

extension TrayController {
    /// Convert a white-background PNG into an RGBA image where near-
    /// white pixels become transparent. Lets us use logos that ship
    /// without an alpha channel as template images that tint with the
    /// macOS theme.
    static func whiteToAlpha(_ image: NSImage, threshold: CGFloat = 0.92) -> NSImage? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        let width = cg.width, height = cg.height
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
            | CGBitmapInfo.byteOrder32Big.rawValue
        guard let ctx = CGContext(
            data: &pixels,
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo,
        ) else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        // Walk each pixel; if it's near-white, make it transparent.
        let cutoff = UInt8(threshold * 255)
        var i = 0
        while i < pixels.count {
            let r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
            if r >= cutoff && g >= cutoff && b >= cutoff {
                pixels[i + 3] = 0
            }
            i += 4
        }
        guard let masked = ctx.makeImage() else { return nil }
        return NSImage(cgImage: masked, size: image.size)
    }
}

// MARK: - SwiftUI tray rows (Liquid Glass)

/// Status header — rendered via NSHostingView inside the NSMenu so we
/// can use SwiftUI's `.glassEffect()` for the real macOS 26 material
/// rather than the AppKit vibrancy fallback the old MemoryBarView used.
struct TrayHeaderSwiftUIView: View {
    let provider: String?
    let embedRunning: Bool
    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(provider != nil ? Color.green : Color.gray)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(provider.map { "Detour: \($0)" } ?? "Detour: no provider")
                    .font(.system(size: 13, weight: .semibold))
                if !embedRunning {
                    Text("embeddings starting…")
                        .font(.system(size: 10))
                        .foregroundStyle(Color.orange)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 10))
        .padding(.horizontal, 6).padding(.vertical, 3)
    }
}

/// Memory budget bar — Liquid Glass capsule with green/amber/red fill.
struct TrayMemoryBarSwiftUIView: View {
    let memory: TrayMemory
    private var pct: Double {
        memory.budgetGB > 0 ? min(1.0, memory.usedGB / memory.budgetGB) : 0
    }
    private var tone: Color {
        if pct >= 0.9 { return .red }
        if pct >= 0.7 { return .orange }
        return .green
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Memory").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                Spacer()
                Text(String(format: "%.1f / %.1f GB", memory.usedGB, memory.budgetGB))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.gray.opacity(0.18))
                    Capsule().fill(tone).frame(width: max(4, geo.size.width * pct))
                }
            }
            .frame(height: 5)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .glassEffect(.regular, in: .rect(cornerRadius: 10))
        .padding(.horizontal, 6).padding(.vertical, 3)
    }
}
