/*
 * Common SwiftUI components shared across Detour companions —
 * memory budget bar, status pill, empty state, deep-link button.
 * Pulled out so every companion has the same look.
 */

import SwiftUI

// MARK: - Memory budget bar

struct MemoryBudgetBar: View {
    let memory: TrayMemoryWire
    var compact: Bool = false
    private var fraction: Double {
        memory.budgetGB > 0 ? min(1.0, memory.usedGB / memory.budgetGB) : 0
    }
    private var tone: Color {
        fraction >= 0.9 ? .red : fraction >= 0.7 ? .orange : .green
    }
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 6) {
            HStack {
                Text("RAM budget").font(compact ? .caption : .headline)
                Spacer()
                Text(String(format: "%.1f / %.1f GB · %.1f held back",
                            memory.usedGB, memory.budgetGB, memory.headroomGB))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: fraction).tint(tone)
        }
        .padding(compact ? 8 : 14)
        .background(Color.gray.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Status pill

struct StatusPill: View {
    let label: String
    let on: Bool
    var subtitle: String? = nil
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(on ? Color.green : Color.gray)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.system(.caption, weight: .medium))
                if let subtitle {
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.gray.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Empty state

struct EmptyStateView: View {
    let title: String
    var subtitle: String? = nil
    var systemImage: String = "tray"
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text(title).font(.headline).foregroundStyle(.secondary)
            if let subtitle {
                Text(subtitle).font(.caption).foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

// MARK: - "Open in main window" deep link

struct DeepLinkButton: View {
    let label: String
    let url: String
    let client: DetourClient
    var body: some View {
        Button(action: { client.openDetourURL(url) }) {
            HStack {
                Text(label)
                Spacer()
                Image(systemName: "arrow.up.right.square").foregroundStyle(.tertiary)
            }
        }
        .buttonStyle(.plain)
        .font(.system(size: 11))
    }
}

// MARK: - Connection error banner

struct ConnectionErrorBanner: View {
    let message: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading) {
                Text("Can't reach Detour").font(.callout).bold()
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.orange.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Time formatting

extension Double {
    /// Treat self as a Unix-ms timestamp and return "5m ago" style.
    func relativeTimeAgo() -> String {
        let delta = Date().timeIntervalSince1970 - (self / 1000)
        if delta < 60 { return "just now" }
        if delta < 3600 { return "\(Int(delta / 60))m ago" }
        if delta < 86400 { return "\(Int(delta / 3600))h ago" }
        return "\(Int(delta / 86400))d ago"
    }
}
