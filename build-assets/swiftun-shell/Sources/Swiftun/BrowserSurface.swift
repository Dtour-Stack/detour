/*
 * BrowserSurface — native SwiftUI WKWebView wrapped in a URL bar +
 * back/forward chrome. This is the agent-browser: it loads real web
 * pages (the agent uses it to drive sites, the user uses it for
 * preview / inspection). Unlike the old "chat WKWebView pointing at
 * the React shell" — which white-screened because the bundle expected
 * Electrobun's RPC bridge — this one loads ordinary websites and works.
 */

import AppKit
import SwiftUI
import WebKit

struct BrowserRootView: View {
    @StateObject private var vm = BrowserViewModel()
    var body: some View {
        VStack(spacing: 0) {
            BrowserToolbar(vm: vm)
            Divider()
            BrowserWebView(vm: vm)
                .background(Color.gray.opacity(0.06))
        }
        .frame(minWidth: 900, idealWidth: 1280, minHeight: 600, idealHeight: 820)
    }
}

@MainActor
final class BrowserViewModel: ObservableObject {
    @Published var address: String = "https://www.google.com"
    @Published var canGoBack: Bool = false
    @Published var canGoForward: Bool = false
    @Published var loading: Bool = false
    @Published var pendingURL: URL? = URL(string: "https://www.google.com")
    var webViewRef: WKWebView?

    func go() {
        let s = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return }
        var candidate = s
        if !candidate.hasPrefix("http://") && !candidate.hasPrefix("https://") {
            // Treat space-free strings with a dot as a host, else search.
            if candidate.contains(".") && !candidate.contains(" ") {
                candidate = "https://" + candidate
            } else {
                let q = candidate.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? candidate
                candidate = "https://www.google.com/search?q=\(q)"
            }
        }
        if let u = URL(string: candidate) {
            pendingURL = u
            webViewRef?.load(URLRequest(url: u))
        }
    }

    func back() { webViewRef?.goBack() }
    func forward() { webViewRef?.goForward() }
    func reload() { webViewRef?.reload() }
}

private struct BrowserToolbar: View {
    @ObservedObject var vm: BrowserViewModel
    var body: some View {
        HStack(spacing: 8) {
            Button(action: { vm.back() }) {
                Image(systemName: "chevron.left").frame(width: 22, height: 22)
            }
            .disabled(!vm.canGoBack)
            Button(action: { vm.forward() }) {
                Image(systemName: "chevron.right").frame(width: 22, height: 22)
            }
            .disabled(!vm.canGoForward)
            Button(action: { vm.reload() }) {
                Image(systemName: vm.loading ? "xmark" : "arrow.clockwise").frame(width: 22, height: 22)
            }
            TextField("Search or enter URL", text: $vm.address)
                .textFieldStyle(.roundedBorder)
                .onSubmit { vm.go() }
                .glassEffect(.regular, in: .capsule)
            if vm.loading { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct BrowserWebView: NSViewRepresentable {
    @ObservedObject var vm: BrowserViewModel
    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.allowsBackForwardNavigationGestures = true
        if let u = vm.pendingURL {
            wv.load(URLRequest(url: u))
        }
        DispatchQueue.main.async { vm.webViewRef = wv }
        return wv
    }
    func updateNSView(_ wv: WKWebView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(vm: vm) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let vm: BrowserViewModel
        init(vm: BrowserViewModel) { self.vm = vm }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            Task { @MainActor in
                self.vm.loading = true
                if let u = webView.url { self.vm.address = u.absoluteString }
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                self.vm.loading = false
                self.vm.canGoBack = webView.canGoBack
                self.vm.canGoForward = webView.canGoForward
                if let u = webView.url { self.vm.address = u.absoluteString }
            }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in self.vm.loading = false }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in self.vm.loading = false }
        }
    }
}
