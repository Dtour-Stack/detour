/*
 * GallerySurface — native SwiftUI grid of generated media (images,
 * videos) the agent has produced. Backed by ~/.detour/media which the
 * media-generation + audio-generation plugins write into. Click an
 * item → QuickLook preview. Drag → standard NSFilePromise.
 *
 * Liquid Glass tiles via .glassEffect on each thumbnail wrapper.
 */

import AppKit
import Quartz
import SwiftUI

struct GalleryItem: Identifiable, Hashable {
    let id: String
    let url: URL
    let createdAt: Date
    let kind: GalleryKind
    var name: String { url.lastPathComponent }
}

enum GalleryKind: String { case image, video, audio, other }

@MainActor
final class GalleryViewModel: ObservableObject {
    @Published var items: [GalleryItem] = []
    @Published var loading = false
    @Published var error: String? = nil

    private var mediaRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".detour")
            .appendingPathComponent("media")
    }

    func refresh() {
        loading = true
        error = nil
        let root = mediaRoot
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var collected: [GalleryItem] = []
            if let enumerator = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: [.creationDateKey, .isRegularFileKey, .typeIdentifierKey],
                options: [.skipsHiddenFiles],
            ) {
                for case let url as URL in enumerator {
                    let vals = try? url.resourceValues(forKeys: [.isRegularFileKey, .creationDateKey, .typeIdentifierKey])
                    if vals?.isRegularFile != true { continue }
                    let ext = url.pathExtension.lowercased()
                    let kind: GalleryKind
                    if ["png", "jpg", "jpeg", "webp", "gif", "heic", "tiff"].contains(ext) { kind = .image }
                    else if ["mp4", "mov", "webm", "m4v"].contains(ext) { kind = .video }
                    else if ["mp3", "wav", "m4a", "aiff"].contains(ext) { kind = .audio }
                    else { kind = .other }
                    let createdAt = vals?.creationDate ?? Date.distantPast
                    collected.append(GalleryItem(
                        id: url.path, url: url,
                        createdAt: createdAt, kind: kind,
                    ))
                }
            }
            collected.sort { $0.createdAt > $1.createdAt }
            Task { @MainActor in
                if !FileManager.default.fileExists(atPath: root.path) {
                    self.error = "~/.detour/media doesn't exist yet — the agent hasn't generated any media."
                }
                self.items = collected
                self.loading = false
            }
        }
    }

    func revealInFinder(_ item: GalleryItem) {
        NSWorkspace.shared.activateFileViewerSelecting([item.url])
    }

    func quickLook(_ item: GalleryItem) {
        // QuickLook panel — system standard preview window.
        guard let panel = QLPreviewPanel.shared() else { return }
        QuickLookSource.shared.items = [item.url as QLPreviewItem]
        panel.dataSource = QuickLookSource.shared
        panel.makeKeyAndOrderFront(nil)
    }
}

/// Singleton QuickLook data source — QLPreviewPanel uses a long-lived
/// data source ref and we can't reuse one tied to a transient view.
final class QuickLookSource: NSObject, QLPreviewPanelDataSource, @unchecked Sendable {
    static let shared = QuickLookSource()
    var items: [QLPreviewItem] = []
    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { items.count }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        items[index]
    }
}

struct GalleryRootView: View {
    @StateObject private var vm = GalleryViewModel()
    @State private var selectedKind: GalleryKind? = nil

    private var filtered: [GalleryItem] {
        guard let k = selectedKind else { return vm.items }
        return vm.items.filter { $0.kind == k }
    }

    private let columns = [GridItem(.adaptive(minimum: 160, maximum: 220), spacing: 14)]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("Gallery").font(.title2).bold()
                Spacer()
                Picker("Kind", selection: $selectedKind) {
                    Text("All").tag(GalleryKind?.none)
                    Text("Images").tag(Optional(GalleryKind.image))
                    Text("Videos").tag(Optional(GalleryKind.video))
                    Text("Audio").tag(Optional(GalleryKind.audio))
                }.pickerStyle(.segmented).frame(width: 280)
                Button(action: { vm.refresh() }) {
                    Image(systemName: "arrow.clockwise")
                }.buttonStyle(.borderless)
            }
            .padding(14)
            Divider()

            if vm.loading && vm.items.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filtered.isEmpty {
                EmptyStateView(
                    title: "No media yet",
                    subtitle: vm.error ?? "The agent's image/video/audio generations land here.",
                    systemImage: "photo.on.rectangle.angled",
                )
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(filtered) { item in
                            GalleryThumbnail(item: item)
                                .onTapGesture(count: 2) { vm.quickLook(item) }
                                .contextMenu {
                                    Button("Quick Look") { vm.quickLook(item) }
                                    Button("Reveal in Finder") { vm.revealInFinder(item) }
                                    Divider()
                                    Button("Copy path") {
                                        NSPasteboard.general.clearContents()
                                        NSPasteboard.general.setString(item.url.path, forType: .string)
                                    }
                                }
                        }
                    }
                    .padding(14)
                }
            }
        }
        .frame(minWidth: 760, idealWidth: 1100, minHeight: 600, idealHeight: 760)
        .onAppear { vm.refresh() }
    }
}

private struct GalleryThumbnail: View {
    let item: GalleryItem
    @State private var thumb: NSImage? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                if let img = thumb {
                    Image(nsImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: placeholderIcon())
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 140)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 10))

            HStack {
                Text(item.name).font(.caption).lineLimit(1)
                Spacer()
                Text(item.createdAt.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
        .onAppear { loadThumb() }
    }

    private func loadThumb() {
        if item.kind == .image {
            DispatchQueue.global(qos: .userInitiated).async {
                let img = NSImage(contentsOf: item.url)
                DispatchQueue.main.async { self.thumb = img }
            }
        }
    }

    private func placeholderIcon() -> String {
        switch item.kind {
        case .image: return "photo"
        case .video: return "play.rectangle"
        case .audio: return "waveform"
        case .other: return "doc"
        }
    }
}
