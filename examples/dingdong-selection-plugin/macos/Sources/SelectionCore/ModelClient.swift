import Foundation

public enum ModelClientError: Error, Equatable, LocalizedError {
    case emptyModel
    case insecureRemoteEndpoint
    case localEndpointRequired
    case invalidEndpoint
    case tokenRequired
    case unsupportedAction
    case invalidResponse
    case responseTooLarge
    case requestFailed(statusCode: Int)

    public var errorDescription: String? {
        switch self {
        case .emptyModel:
            return "请先配置模型名称。"
        case .insecureRemoteEndpoint:
            return "远程模型地址必须使用 HTTPS；HTTP 只允许本机回环地址。"
        case .localEndpointRequired:
            return "Ollama 和 LM Studio 只允许连接本机回环地址。"
        case .invalidEndpoint:
            return "模型服务地址无效。"
        case .tokenRequired:
            return "这个云端模型需要你自己的 API token。"
        case .unsupportedAction:
            return "复制操作不会调用模型。"
        case .invalidResponse:
            return "模型服务返回了无法识别的结果。"
        case .responseTooLarge:
            return "模型服务返回内容过大，已拒绝加载。"
        case let .requestFailed(statusCode):
            return "模型服务请求失败（HTTP \(statusCode)）。"
        }
    }
}

public enum ModelRequestFactory {
    public static func makeRequest(
        action: SelectionAction,
        text: String,
        configuration: ModelConfiguration,
        token: String?
    ) throws -> URLRequest {
        guard action != .copy else { throw ModelClientError.unsupportedAction }
        guard !configuration.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ModelClientError.emptyModel
        }
        try validateEndpoint(configuration)

        let normalizedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        if configuration.requiresToken, normalizedToken?.isEmpty != false {
            throw ModelClientError.tokenRequired
        }

        let path = configuration.provider == .ollama ? "api/chat" : "chat/completions"
        guard let endpoint = appending(path: path, to: configuration.baseURL) else {
            throw ModelClientError.invalidEndpoint
        }

        let prompt = SelectionPrompt.make(
            action: action,
            text: text,
            targetLanguage: configuration.targetLanguage
        )
        let messages: [[String: String]] = [
            ["role": "system", "content": prompt.system],
            ["role": "user", "content": prompt.user]
        ]

        var body: [String: Any] = [
            "model": configuration.model,
            "messages": messages,
            "stream": false
        ]
        if configuration.provider == .ollama {
            body["think"] = false
            body["keep_alive"] = configuration.unloadLocalModelAfterResponse ? 0 : "5m"
        } else {
            body["temperature"] = 0.2
            body["max_tokens"] = 768
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if configuration.requiresToken, let normalizedToken, !normalizedToken.isEmpty {
            request.setValue("Bearer \(normalizedToken)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return request
    }

    private static func validateEndpoint(_ configuration: ModelConfiguration) throws {
        let url = configuration.baseURL
        guard let scheme = url.scheme?.lowercased(), url.host != nil else {
            throw ModelClientError.invalidEndpoint
        }
        guard url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil else {
            throw ModelClientError.invalidEndpoint
        }
        if configuration.provider == .ollama || configuration.provider == .lmStudio {
            guard url.isLoopbackHTTP else {
                throw ModelClientError.localEndpointRequired
            }
            return
        }
        if scheme == "https" || url.isLoopbackHTTP { return }
        if scheme == "http" { throw ModelClientError.insecureRemoteEndpoint }
        throw ModelClientError.invalidEndpoint
    }

    private static func appending(path: String, to baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let basePath = components.path.split(separator: "/").map(String.init)
        let extraPath = path.split(separator: "/").map(String.init)
        components.path = "/" + (basePath + extraPath).joined(separator: "/")
        components.query = nil
        components.fragment = nil
        return components.url
    }
}

public enum ModelResponseParser {
    public static let maximumResponseBytes = 1_048_576

    public static func parse(_ data: Data, provider: ModelProviderKind) throws -> String {
        guard data.count <= maximumResponseBytes else {
            throw ModelClientError.responseTooLarge
        }
        let content: String?
        if provider == .ollama {
            content = try JSONDecoder().decode(OllamaResponse.self, from: data).message.content
        } else {
            content = try JSONDecoder().decode(CompatibleResponse.self, from: data)
                .choices.first?.message.content
        }
        guard let normalized = content?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalized.isEmpty else {
            throw ModelClientError.invalidResponse
        }
        return normalized
    }
}

public struct BoundedDataCollector: Sendable {
    public let maximumBytes: Int
    public private(set) var data = Data()

    public init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    public mutating func append(_ chunk: Data) throws {
        guard chunk.count <= maximumBytes - data.count else {
            throw ModelClientError.responseTooLarge
        }
        data.append(chunk)
    }

    public mutating func append(_ byte: UInt8) throws {
        guard data.count < maximumBytes else {
            throw ModelClientError.responseTooLarge
        }
        data.append(byte)
    }
}

public final class HTTPModelClient: @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession) {
        self.session = session
    }

    public convenience init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 120
        configuration.waitsForConnectivity = false
        self.init(
            session: URLSession(
                configuration: configuration,
                delegate: SameOriginRedirectDelegate(),
                delegateQueue: nil
            )
        )
    }

    public func generate(
        action: SelectionAction,
        text: String,
        configuration: ModelConfiguration,
        token: String?
    ) async throws -> String {
        let request = try ModelRequestFactory.makeRequest(
            action: action,
            text: text,
            configuration: configuration,
            token: token
        )
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ModelClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ModelClientError.requestFailed(statusCode: http.statusCode)
        }
        if response.expectedContentLength > ModelResponseParser.maximumResponseBytes {
            throw ModelClientError.responseTooLarge
        }
        var collector = BoundedDataCollector(
            maximumBytes: ModelResponseParser.maximumResponseBytes
        )
        for try await byte in bytes {
            try Task.checkCancellation()
            try collector.append(byte)
        }
        return try ModelResponseParser.parse(
            collector.data,
            provider: configuration.provider
        )
    }
}

private final class SameOriginRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let original = task.originalRequest?.url,
              let redirected = request.url,
              original.scheme?.lowercased() == redirected.scheme?.lowercased(),
              original.host?.lowercased() == redirected.host?.lowercased(),
              original.port == redirected.port else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}

private struct OllamaResponse: Decodable {
    struct Message: Decodable { let content: String }
    let message: Message
}

private struct CompatibleResponse: Decodable {
    struct Choice: Decodable {
        struct Message: Decodable { let content: String }
        let message: Message
    }
    let choices: [Choice]
}
