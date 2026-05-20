/*
 * InAppBanner — custom SwiftUI notification banner that always shows
 * the Detour Squirrel icon. Used as the primary banner path because
 * the ad-hoc-signed dev build has UN auth denied (UNNotification
 * banners would show generic / Script Editor icons in that case).
 *
 * Renders top-right of the active screen with a slide-in animation,
 * auto-dismisses after 5s, and is clickable to deep-link into the
 * matching window via WindowFactory.
 */

import AppKit
import SwiftUI

@MainActor
final class InAppBannerManager {
    static let shared = InAppBannerManager()

    private var queue: [InAppBannerPayload] = []
    private var presenting: NSWindow? = nil
    private let bannerWidth: CGFloat = 360
    private let bannerHeight: CGFloat = 84
    private let margin: CGFloat = 16
    private let duration: TimeInterval = 5

    struct InAppBannerPayload {
        let title: String
        let body: String
        let target: String  // chat / settings / activity / pet / pensieve
    }

    func show(title: String, body: String, target: String) {
        // DISABLED. The in-app banner is the source of a persistent
        // EXC_BAD_ACCESS in `_NSWindowTransformAnimation dealloc` during
        // CA::Transaction::commit on rapid chat replies — borderless
        // NSWindow create/orderOut/close churn races with Core Animation
        // transaction commits even after removing every explicit
        // animation. The notification path still produces:
        //   - tray badge unread count (TrayController.setUnread)
        //   - UN system banner if user granted notification auth
        //   - pet sprite reaction (waving state on chatComplete)
        // Those are enough to convey "Detour replied" without spawning
        // an ephemeral window per turn.
        _ = title; _ = body; _ = target; _ = queue; _ = presenting
        return
    }
    func _showDisabled(title: String, body: String, target: String) {
        let payload = InAppBannerPayload(title: title, body: body, target: target)
        if presenting == nil {
            present(payload)
        } else {
            queue.append(payload)
        }
    }

    private func present(_ payload: InAppBannerPayload) {
        // Skip the in-app banner entirely when the chat window is
        // already visible — the user is looking at the conversation,
        // a banner saying "Detour replied" is just noise.
        if isChatWindowVisible() {
            // Still drain the queue so we don't get stuck.
            if let next = queue.first {
                queue.removeFirst()
                DispatchQueue.main.async { [weak self] in self?.present(next) }
            }
            return
        }
        guard let screen = NSScreen.main else { return }
        let frame = screen.visibleFrame
        let onScreenRect = NSRect(
            x: frame.maxX - bannerWidth - margin,
            y: frame.maxY - bannerHeight - margin,
            width: bannerWidth,
            height: bannerHeight,
        )

        let host = NSHostingController(rootView: AnyView(
            InAppBannerView(
                title: payload.title,
                bodyText: payload.body,
                onTap: { [weak self] in
                    WindowFactory.shared.open(target: payload.target)
                    self?.dismissCurrent()
                },
                onDismiss: { [weak self] in self?.dismissCurrent() },
            ).detourAccent(),
        ))

        // No NSAnimationContext / window-transform animation — those
        // produced a recurring SIGSEGV in
        // _NSWindowTransformAnimation.dealloc during CA's transaction
        // commit. Present statically; auto-dismiss the same way.
        let win = NSWindow(
            contentRect: onScreenRect,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
        )
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = true
        win.level = .floating
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        win.contentViewController = host
        win.ignoresMouseEvents = false
        win.makeKeyAndOrderFront(nil)
        presenting = win

        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self, weak win] in
            guard let win = win, win == self?.presenting else { return }
            self?.dismissCurrent()
        }
    }

    private func dismissCurrent() {
        guard let win = presenting else { return }
        presenting = nil
        win.orderOut(nil)
        // Defer close one runloop tick so any in-flight Core Animation
        // transactions touching this window can finish first.
        DispatchQueue.main.async { [weak self, weak win] in
            win?.close()
            if let next = self?.queue.first {
                self?.queue.removeFirst()
                self?.present(next)
            }
        }
    }

    /// True when ChatRootView has a key/visible NSWindow on screen.
    /// Used to suppress the in-app banner when the user is already
    /// looking at the chat surface.
    private func isChatWindowVisible() -> Bool {
        for w in NSApplication.shared.windows where w.isVisible {
            if w.title == "Detour" && w.contentViewController != nil {
                // Heuristic: title is "Detour" + has a controller.
                // Not perfect but good enough to skip the banner.
                return w.frame.width >= 700
            }
        }
        return false
    }
}

private struct InAppBannerView: View {
    let title: String
    let bodyText: String  // renamed to avoid collision with View.body
    let onTap: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if let url = NotificationManager.appIconURL(),
               let nsImg = NSImage(contentsOf: url) {
                Image(nsImage: nsImg)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                Image(systemName: "puzzlepiece.fill")
                    .font(.system(size: 28))
                    .frame(width: 44, height: 44)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).lineLimit(1)
                Text(bodyText).font(.callout).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark").font(.caption).foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
    }
}
