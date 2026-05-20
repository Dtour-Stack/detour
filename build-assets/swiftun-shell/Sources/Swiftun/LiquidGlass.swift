/*
 * LiquidGlass — shared SwiftUI primitives that apply Apple's Liquid Glass
 * material (macOS 26+) to Detour's native surfaces. The OS draws the
 * actual translucent / refractive material; we just compose with it.
 *
 * Usage:
 *   GlassCard("Active provider") { Text("Anthropic") }
 *   GlassToolbar { … toolbar buttons … }
 *   Sidebar uses .glassEffect(.regular, in: …) directly via modifiers.
 *
 * Why a single primitive: every native window in Detour reaches for the
 * same card-shaped translucent container. Centralizing keeps the look
 * consistent and lets us tweak the material once (e.g. swap .regular →
 * .clear for hover states) without touching twenty call sites.
 */

import SwiftUI

/// A Liquid Glass card with a title header + body content. Replaces the
/// older `SettingsCardBox` (kept for now as an alias) so every settings
/// surface picks up the material at once.
struct GlassCard<Content: View>: View {
    let title: String
    let systemImage: String?
    @ViewBuilder var content: Content

    init(_ title: String, systemImage: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                if let sym = systemImage {
                    Image(systemName: sym).foregroundStyle(.secondary)
                }
                Text(title).font(.headline)
                Spacer()
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 12))
    }
}

/// Horizontal Liquid Glass row of controls — used at the top of windows
/// for the title + actions strip.
struct GlassToolbar<Content: View>: View {
    @ViewBuilder var content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        HStack(spacing: 10) { content }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }
}

/// A pill-shaped Liquid Glass capsule for status indicators that should
/// float above their background. Replaces the older StatusPill where the
/// material adds visual interest without competing with content.
struct GlassPill: View {
    let label: String
    let systemImage: String?
    let tint: Color

    init(_ label: String, systemImage: String? = nil, tint: Color = .accentColor) {
        self.label = label
        self.systemImage = systemImage
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: 5) {
            if let sym = systemImage { Image(systemName: sym).foregroundStyle(tint) }
            Text(label).font(.caption).fontWeight(.medium)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .glassEffect(.regular, in: .capsule)
    }
}

/// Window background that pairs Liquid Glass with the system background
/// color so content reads cleanly on both light and dark menu-bar themes.
struct GlassWindowBackground: View {
    var body: some View {
        Rectangle()
            .fill(.background)
            .ignoresSafeArea()
    }
}

/// Resolve a Color from the Appearance → Accent picker string. Used by
/// the `DetourAccent` view modifier to apply a uniform tint to every
/// SwiftUI root in the app.
func detourAccentColor(for value: String) -> Color? {
    switch value {
    case "blue": return .blue
    case "purple": return .purple
    case "green": return .green
    case "orange": return .orange
    case "pink": return .pink
    case "red": return .red
    case "yellow": return .yellow
    default: return nil  // system default
    }
}

/// View modifier that applies the currently-selected accent color from
/// `@AppStorage("detour.appearance.accent")`. Wrap every NSHostingController's
/// root view with `.detourAccent()` so changing the picker re-tints
/// buttons, toggles, segmented controls, etc.
struct DetourAccentModifier: ViewModifier {
    @AppStorage("detour.appearance.accent") private var accent = "system"
    func body(content: Content) -> some View {
        if let color = detourAccentColor(for: accent) {
            content.tint(color).accentColor(color)
        } else {
            content
        }
    }
}

extension View {
    /// Apply the user's Appearance → Accent selection to this subtree.
    /// Effectively `.tint(Color)` where the color comes from
    /// `@AppStorage("detour.appearance.accent")`.
    func detourAccent() -> some View {
        modifier(DetourAccentModifier())
    }
}
