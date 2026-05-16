/*
 * PetSurface — the floating Detour Squirrel sprite, now animating
 * through the full 9-state codex-pets spritesheet:
 *
 *   spritesheet.webp: 1536×1872, 8 cols × 9 rows, 192×208 cells
 *   row 0  idle           6 frames  neutral breathing/blinking loop
 *   row 1  running-right  8 frames
 *   row 2  running-left   8 frames
 *   row 3  waving         4 frames  greeting
 *   row 4  jumping        5 frames
 *   row 5  failed         8 frames  sad/dizzy
 *   row 6  waiting        6 frames
 *   row 7  running        6 frames  in-place
 *   row 8  review         6 frames  focused inspecting
 *
 * Each frame is rendered by drawing the slice (cellW × cellH at
 * row*cellH, col*cellW) onto a SwiftUI Canvas. Frame advancement is
 * driven by TimelineView so animation continues even when the window
 * is in the background.
 *
 * Source assets ship in the bun-payload tree at
 *   Contents/Resources/app/views/main/pets/<id>/spritesheet.webp
 * The pet view scans that dir on launch and uses the first pet found.
 */

import AppKit
import SwiftUI

/// One row in the canonical Codex-pet atlas.
struct PetAnimationRow {
    let state: String
    let row: Int
    let frames: Int
}

/// Atlas dimensions — every Codex pet spritesheet uses this exact grid.
struct PetAtlas {
    static let columns = 8
    static let rows = 9
    static let cellWidth = 192
    static let cellHeight = 208
    static let allRows: [PetAnimationRow] = [
        .init(state: "idle",          row: 0, frames: 6),
        .init(state: "running-right", row: 1, frames: 8),
        .init(state: "running-left",  row: 2, frames: 8),
        .init(state: "waving",        row: 3, frames: 4),
        .init(state: "jumping",       row: 4, frames: 5),
        .init(state: "failed",        row: 5, frames: 8),
        .init(state: "waiting",       row: 6, frames: 6),
        .init(state: "running",       row: 7, frames: 6),
        .init(state: "review",        row: 8, frames: 6),
    ]
    static func find(_ state: String) -> PetAnimationRow {
        allRows.first { $0.state == state } ?? allRows[0]
    }
}

/// Loaded pet sprite — keeps the parent NSImage AND a per-frame
/// CGImage cache so we don't re-slice on every redraw.
final class PetSprite {
    let image: NSImage
    private var cache: [String: CGImage] = [:]
    init(image: NSImage) { self.image = image }

    func frame(row: Int, col: Int) -> CGImage? {
        let key = "\(row)x\(col)"
        if let cached = cache[key] { return cached }
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let rect = CGRect(
            x: col * PetAtlas.cellWidth,
            y: row * PetAtlas.cellHeight,
            width: PetAtlas.cellWidth,
            height: PetAtlas.cellHeight,
        )
        guard let cropped = cg.cropping(to: rect) else { return nil }
        cache[key] = cropped
        return cropped
    }
}

/// One pet bundle — sprite + companion model preset + skill focus +
/// narrator persona. Loaded from `Contents/Resources/app/views/main/
/// pets/<id>/pet.json`.
struct PetBundle: Identifiable, Hashable {
    let id: String
    let displayName: String
    let description: String
    let spritesheetPath: URL
    let companionPreset: String?
    let persona: String?
    let petSkills: [String]
}

/// Enumerate every bundled pet on disk. Used by the right-click pet
/// switcher.
func loadPetBundles() -> [PetBundle] {
    let petsRoot = Bundle.main.bundleURL
        .appendingPathComponent("Contents")
        .appendingPathComponent("Resources")
        .appendingPathComponent("app")
        .appendingPathComponent("views")
        .appendingPathComponent("main")
        .appendingPathComponent("pets")
    let fm = FileManager.default
    guard let petDirs = try? fm.contentsOfDirectory(at: petsRoot,
                                                    includingPropertiesForKeys: [.isDirectoryKey],
                                                    options: [.skipsHiddenFiles]) else {
        return []
    }
    var bundles: [PetBundle] = []
    for petDir in petDirs.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
        let manifest = petDir.appendingPathComponent("pet.json")
        let sheet = petDir.appendingPathComponent("spritesheet.webp")
        guard fm.fileExists(atPath: manifest.path),
              fm.fileExists(atPath: sheet.path),
              let data = try? Data(contentsOf: manifest),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        let id = (json["id"] as? String) ?? petDir.lastPathComponent
        let name = (json["displayName"] as? String) ?? id
        let desc = (json["description"] as? String) ?? ""
        let preset = json["companionPreset"] as? String
        let persona = json["persona"] as? String
        let skills = (json["petSkills"] as? [String]) ?? []
        bundles.append(PetBundle(
            id: id,
            displayName: name,
            description: desc,
            spritesheetPath: sheet,
            companionPreset: preset,
            persona: persona,
            petSkills: skills,
        ))
    }
    return bundles
}

/// Resolve the active pet from UserDefaults, with the first bundle on
/// disk as the default.
func activePetBundle(from bundles: [PetBundle]) -> PetBundle? {
    let saved = UserDefaults.standard.string(forKey: "detour.pet.activeId")
    if let saved, let match = bundles.first(where: { $0.id == saved }) { return match }
    return bundles.first
}

/// Persist the active pet id + ping bun to start its companion model
/// and apply its persona + skill focus to the narrator.
func activatePet(_ pet: PetBundle) {
    UserDefaults.standard.set(pet.id, forKey: "detour.pet.activeId")
    Task.detached {
        let endpoint = URL(string: "http://127.0.0.1:2138/api/eval/active-pet")!
        var req = URLRequest(url: endpoint, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        // Pull eval token from ~/.detour/.env
        if let env = ProcessInfo.processInfo.environment["DETOUR_EVAL_TOKEN"] {
            req.addValue(env, forHTTPHeaderField: "x-detour-eval-token")
        } else {
            let path = NSString(string: "~/.detour/.env").expandingTildeInPath
            if let text = try? String(contentsOfFile: path, encoding: .utf8) {
                for line in text.split(separator: "\n") {
                    let t = line.trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix("DETOUR_EVAL_TOKEN=") {
                        var v = String(t.dropFirst("DETOUR_EVAL_TOKEN=".count))
                        if (v.hasPrefix("\"") && v.hasSuffix("\"")) || (v.hasPrefix("'") && v.hasSuffix("'")) {
                            v = String(v.dropFirst().dropLast())
                        }
                        req.addValue(v, forHTTPHeaderField: "x-detour-eval-token")
                    }
                }
            }
        }
        var body: [String: Any] = [
            "petId": pet.id,
            "persona": pet.persona ?? "",
            "skills": pet.petSkills,
            "startCompanion": pet.companionPreset != nil,
        ]
        if let preset = pet.companionPreset {
            body["companionPreset"] = preset
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: req)
    }
}

/// Backwards-compat: existing call sites still ask for "a pet sprite".
/// Resolve to the active bundle's sheet.
func loadPetSprite() -> PetSprite? {
    let bundles = loadPetBundles()
    guard let active = activePetBundle(from: bundles),
          let img = NSImage(contentsOf: active.spritesheetPath)
    else { return nil }
    return PetSprite(image: img)
}

/// SwiftUI Canvas-based sprite renderer. TimelineView drives frame
/// advancement at ~10 fps; the state machine picks the active row,
/// then the current frame within that row.
struct PetSpriteView: View {
    let sprite: PetSprite
    @Binding var state: String
    // 5 fps — slower-paced pixel-art cadence that reads as alive
    // without looking jittery. Was 10; user feedback was too fast.
    var fps: Double = 5
    @State private var startedAt = Date()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / fps)) { context in
            let row = PetAtlas.find(state)
            let elapsed = context.date.timeIntervalSince(startedAt)
            let frame = Int(elapsed * fps) % max(1, row.frames)
            Canvas { ctx, size in
                if let cg = sprite.frame(row: row.row, col: frame) {
                    let nsImg = NSImage(cgImage: cg, size: NSSize(width: PetAtlas.cellWidth, height: PetAtlas.cellHeight))
                    ctx.draw(Image(nsImage: nsImg), in: CGRect(origin: .zero, size: size))
                }
            }
        }
    }
}

/// Animation state controller — cycles through "interesting" states
/// occasionally so the pet doesn't sit on idle forever, and watches
/// the SSE stream for chatComplete / workerStatusUpdate to react to
/// agent activity.
@MainActor
final class PetAnimator: ObservableObject {
    @Published var state: String = "idle"
    private var idleCycleTask: Task<Void, Never>?
    private var sseTask: Task<Void, Never>?

    func start() {
        // Background idle cycler: spend most of the time on `idle` but
        // occasionally play `waving`, `running`, `waiting`, `review`.
        idleCycleTask?.cancel()
        idleCycleTask = Task { @MainActor in
            let palette = ["idle", "idle", "idle", "waiting", "review", "waving", "running"]
            while !Task.isCancelled {
                // Sit on idle 10-18s between flourishes (was 4-9s) so
                // the pet feels calmer and the animations don't feel
                // constant. Each flourish runs ~5s.
                try? await Task.sleep(nanoseconds: UInt64.random(in: 10_000_000_000...18_000_000_000))
                if Task.isCancelled { break }
                state = palette.randomElement() ?? "idle"
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                state = "idle"
            }
        }
    }

    /// React to an agent event from the SSE stream. Currently only
    /// chatComplete (wave) and trajectoryFailed (failed) drive state.
    func onAgentEvent(_ name: String) {
        switch name {
        case "chatComplete": state = "waving"
        case "trajectoryFailed": state = "failed"
        case "workerStatusUpdate": state = "running"
        default: break
        }
        // Return to idle after a short burst.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            state = "idle"
        }
    }

    func stop() {
        idleCycleTask?.cancel()
        sseTask?.cancel()
    }
}

struct PetRootView: View {
    @StateObject private var animator = PetAnimator()
    @StateObject private var feed = PetActivityFeed.shared
    @State private var sprite: PetSprite? = loadPetSprite()
    @State private var fallbackBob = false
    @State private var showActions = false
    @State private var didDrag = false

    var body: some View {
        // HStack so the chat bubble can float to the left of the sprite
        // — the pet sits in the bottom-right of the screen so the bubble
        // points outward (toward screen center) and never clips off-screen.
        HStack(alignment: .center, spacing: 6) {
            PetActivityBubble(text: feed.latest)
            ZStack {
                if let s = sprite {
                    PetSpriteView(sprite: s, state: $animator.state, fps: 5)
                        .frame(width: 192, height: 208)
                        .shadow(color: Color.black.opacity(0.18), radius: 6, x: 0, y: 4)
                } else if let url = NotificationManager.appIconURL(),
                          let nsImg = NSImage(contentsOf: url) {
                    Image(nsImage: nsImg)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 96, height: 96)
                        .offset(y: fallbackBob ? -4 : 4)
                        .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: fallbackBob)
                        .onAppear { fallbackBob = true }
                }
            }
            .frame(width: 192, height: 208)
        }
        .frame(width: 460, height: 208, alignment: .trailing)
        .contentShape(Rectangle())
        .onAppear { animator.start() }
        .onDisappear { animator.stop() }
        // Combined drag-or-tap: tap (no movement) opens the actions
        // popover; drag (>4px movement during the gesture) hands off
        // to NSWindow.performDrag so the window moves with the cursor.
        // `didDrag` flag prevents onEnded from interpreting the end of
        // a drag as a tap.
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if didDrag { return }
                    let dx = value.location.x - value.startLocation.x
                    let dy = value.location.y - value.startLocation.y
                    if dx * dx + dy * dy > 16 {
                        didDrag = true
                        if let win = NSApp.windows.first(where: { $0.title == "Detour Pet" }),
                           let event = NSApp.currentEvent {
                            win.performDrag(with: event)
                        }
                    }
                }
                .onEnded { _ in
                    if !didDrag {
                        showActions.toggle()
                    }
                    didDrag = false
                },
        )
        .popover(isPresented: $showActions, arrowEdge: .top) {
            PetActionsMenu(animator: animator, dismiss: { showActions = false })
        }
        .contextMenu {
            Button("Quick actions…") { showActions = true }
            Divider()
            Button("Open Chat") { WindowFactory.shared.open(target: "chat") }
            Button("Open Settings") { WindowFactory.shared.openSettings() }
            Divider()
            Menu("Switch pet") {
                let bundles = loadPetBundles()
                let activeId = UserDefaults.standard.string(forKey: "detour.pet.activeId")
                ForEach(bundles) { bundle in
                    Button(action: {
                        activatePet(bundle)
                        // Hot-swap the sprite without re-launching the
                        // window so the user sees the new pet inline.
                        sprite = NSImage(contentsOf: bundle.spritesheetPath).map { PetSprite(image: $0) }
                    }) {
                        HStack {
                            if bundle.id == activeId {
                                Image(systemName: "checkmark")
                            }
                            Text("\(bundle.displayName) — \(bundle.companionPreset ?? "no preset")")
                        }
                    }
                }
            }
            Menu("Force animation") {
                ForEach(PetAtlas.allRows, id: \.state) { row in
                    Button(row.state.capitalized) { animator.state = row.state }
                }
            }
            Divider()
            Button("Hide pet") { WindowFactory.shared.closePet() }
        }
        .task {
            // On first appearance, ensure the active pet's companion +
            // narrator config is applied. This boots the local model the
            // user last picked (or the default Detour Squirrel bundle).
            let bundles = loadPetBundles()
            if let active = activePetBundle(from: bundles) {
                activatePet(active)
            }
        }
    }
}

/// Fast-actions popover that pops out of the pet on tap. A quick-chat
/// field at the top sends a one-shot turn through /api/eval/send (so
/// the user can ask Detour anything without opening the chat window),
/// then a vertical stack of one-click actions for the most common
/// operations.
private struct PetActionsMenu: View {
    @ObservedObject var animator: PetAnimator
    let dismiss: () -> Void

    @State private var quickPrompt: String = ""
    @State private var sending: Bool = false
    @State private var lastReply: String? = nil
    @FocusState private var promptFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Quick-chat composer
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(.tint)
                TextField("Ask Detour…", text: $quickPrompt)
                    .textFieldStyle(.roundedBorder)
                    .focused($promptFocused)
                    .onSubmit { Task { await send() } }
                if sending {
                    ProgressView().controlSize(.mini)
                } else {
                    Button(action: { Task { await send() } }) {
                        Image(systemName: "arrow.up.circle.fill").font(.title3)
                    }
                    .buttonStyle(.plain)
                    .disabled(quickPrompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            if let r = lastReply {
                Text(r).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(3).textSelection(.enabled)
                    .padding(8)
                    .glassEffect(.regular, in: .rect(cornerRadius: 8))
            }
            Divider()

            // Fast-action grid
            VStack(spacing: 4) {
                PetActionButton(label: "Open chat", systemImage: "ellipsis.bubble") {
                    WindowFactory.shared.open(target: "chat"); dismiss()
                }
                PetActionButton(label: "Search memory", systemImage: "magnifyingglass") {
                    WindowFactory.shared.openPensieve(); dismiss()
                }
                PetActionButton(label: "Open knowledge (logs, trajectories…)", systemImage: "list.bullet.indent") {
                    WindowFactory.shared.openActivity(); dismiss()
                }
                PetActionButton(label: "Browser", systemImage: "globe") {
                    WindowFactory.shared.open(target: "browser"); dismiss()
                }
                PetActionButton(label: "Gallery", systemImage: "photo.on.rectangle.angled") {
                    WindowFactory.shared.open(target: "gallery"); dismiss()
                }
                PetActionButton(label: "Workspace", systemImage: "folder") {
                    WindowFactory.shared.open(target: "workspace"); dismiss()
                }
                Divider().padding(.vertical, 2)
                PetActionButton(label: "Settings", systemImage: "gearshape") {
                    WindowFactory.shared.openSettings(); dismiss()
                }
                PetActionButton(label: "Test notification", systemImage: "bell.badge") {
                    Task {
                        _ = await NotificationManager.shared.sendTestNotification()
                    }
                    dismiss()
                }
                PetActionButton(label: "Hide pet", systemImage: "eye.slash") {
                    WindowFactory.shared.closePet()
                }
            }
        }
        .padding(14)
        .frame(width: 280)
        .onAppear { promptFocused = true }
    }

    private func send() async {
        let text = quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        await MainActor.run {
            sending = true
            lastReply = nil
            animator.state = "review"  // visual cue: pet "thinks"
        }
        defer {
            Task { @MainActor in
                sending = false
                animator.state = "idle"
            }
        }
        // Resolve eval token directly (no DetourClient binding here).
        let token: String? = {
            if let env = ProcessInfo.processInfo.environment["DETOUR_EVAL_TOKEN"], !env.isEmpty { return env }
            let path = NSString(string: "~/.detour/.env").expandingTildeInPath
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
            for line in text.split(separator: "\n") {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("DETOUR_EVAL_TOKEN=") {
                    var v = String(t.dropFirst("DETOUR_EVAL_TOKEN=".count))
                    if (v.hasPrefix("\"") && v.hasSuffix("\"")) || (v.hasPrefix("'") && v.hasSuffix("'")) {
                        v = String(v.dropFirst().dropLast())
                    }
                    return v.isEmpty ? nil : v
                }
            }
            return nil
        }()
        guard let token else {
            await MainActor.run { lastReply = "DETOUR_EVAL_TOKEN not set." }
            return
        }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:2138/api/eval/send")!,
                             timeoutInterval: 90)
        req.httpMethod = "POST"
        req.addValue(token, forHTTPHeaderField: "x-detour-eval-token")
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "text": text, "wait": true, "timeoutMs": 60000,
        ])
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let reply = (obj["reply"] as? String) ?? ""
                await MainActor.run {
                    lastReply = reply.isEmpty ? "(no reply)" : reply
                    quickPrompt = ""
                    animator.state = "waving"
                }
            }
        } catch {
            await MainActor.run {
                lastReply = "Send failed: \(error.localizedDescription)"
                animator.state = "failed"
            }
        }
    }
}

private struct PetActionButton: View {
    let label: String
    let systemImage: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack {
                Image(systemName: systemImage).frame(width: 18)
                Text(label).font(.callout)
                Spacer()
            }
            .padding(.vertical, 4).padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Chat-bubble that floats to the left of the pet showing whatever
/// the agent is currently doing. Invisible (zero opacity) when there's
/// no recent activity; slides in and out with a smooth transition.
struct PetActivityBubble: View {
    let text: String?
    var body: some View {
        // NO .transition() and NO .animation() here.
        // The bubble lives inside a borderless transparent NSWindow that
        // sits on the always-on-top floating level. SwiftUI's `.move`
        // transition cascades into AppKit's _NSWindowTransformAnimation,
        // which racy-deallocates during CA::Transaction::commit on next-
        // frame — producing an EXC_BAD_ACCESS in objc_release. Keep the
        // bubble's appear/disappear instantaneous; the user perceives
        // a clean text swap rather than an animation, and the window
        // never animates.
        Group {
            if let t = text, !t.isEmpty {
                HStack(spacing: 0) {
                    Text(t)
                        .font(.callout)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .glassEffect(.regular, in: .rect(cornerRadius: 14))
                    BubbleTail()
                        .fill(.regularMaterial)
                        .frame(width: 10, height: 14)
                        .offset(x: -2)
                }
                .frame(maxWidth: 240, alignment: .trailing)
            } else {
                Color.clear.frame(width: 1, height: 1)
            }
        }
    }
}

/// Tiny right-pointing triangle that visually connects the bubble to
/// the sprite.
private struct BubbleTail: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 0, y: rect.midY - 6))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        p.addLine(to: CGPoint(x: 0, y: rect.midY + 6))
        p.closeSubpath()
        return p
    }
}

/// Drag the whole window when the user grabs the sprite. SwiftUI
/// gestures can't move an NSWindow directly, so we hop to the hosted
/// window via NSApp and use performDrag.
private struct WindowDragGesture: Gesture {
    var body: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if let win = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.title == "Detour Pet" }) {
                    if let event = NSApp.currentEvent {
                        win.performDrag(with: event)
                    }
                    _ = value
                }
            }
    }
}
