import SwiftUI
import WebKit

@MainActor
final class BrowserNavigationModel: NSObject, ObservableObject, WKNavigationDelegate {
    @Published var address = ""
    @Published var title = "Browser"
    @Published var isLoading = false
    @Published var error: String?
    @Published var canGoBack = false
    @Published var canGoForward = false
    weak var webView: WKWebView?

    func submitAddress() {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: candidate), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else {
            error = "Enter a valid http or https address."
            return
        }
        error = nil
        address = url.absoluteString
        webView?.load(URLRequest(url: url))
    }

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
    func reload() { webView?.reload() }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
        error = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        title = webView.title ?? "Browser"
        address = webView.url?.absoluteString ?? address
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        self.error = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        self.error = error.localizedDescription
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame == nil, let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        webView.load(URLRequest(url: url))
        decisionHandler(.cancel)
    }
}

struct BrowserModuleView: View {
    @StateObject private var model = BrowserNavigationModel()
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Button(action: model.goBack) { Image(systemName: "chevron.left") }
                    .buttonStyle(QuietButtonStyle()).disabled(!model.canGoBack)
                Button(action: model.goForward) { Image(systemName: "chevron.right") }
                    .buttonStyle(QuietButtonStyle()).disabled(!model.canGoForward)
                Button(action: model.reload) { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(QuietButtonStyle())
                HStack {
                    Image(systemName: "lock.fill").foregroundStyle(Theme.cyan)
                    TextField("Search or enter a website", text: $model.address)
                        .textFieldStyle(.plain)
                        .font(Typography.body)
                        .foregroundStyle(Theme.ink)
                        .focused($addressFocused)
                        .onSubmit(model.submitAddress)
                    if model.isLoading { ProgressView().controlSize(.small) }
                }
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity)
                .background(.ultraThinMaterial, in: Capsule())
                Button("Go", action: model.submitAddress).buttonStyle(PrimaryButtonStyle())
            }
            .padding(.horizontal, 16)

            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(Typography.caption).foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18)
            }

            BrowserWebView(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
        }
    }
}

private struct BrowserWebView: UIViewRepresentable {
    @ObservedObject var model: BrowserNavigationModel

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = model
        webView.allowsBackForwardNavigationGestures = true
        model.webView = webView
        model.submitAddress()
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
