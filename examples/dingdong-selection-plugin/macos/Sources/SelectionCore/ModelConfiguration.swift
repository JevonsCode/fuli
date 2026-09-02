import Foundation

public enum ModelProviderKind: String, CaseIterable, Codable, Sendable {
    case ollama
    case lmStudio
    case openRouter
    case gemini
    case openAICompatible
}

public enum ModelPreset: String, CaseIterable, Sendable {
    case ollama
    case lmStudio
    case openRouter
    case gemini
}

public struct ModelConfiguration: Codable, Equatable, Sendable {
    public var provider: ModelProviderKind
    public var baseURL: URL
    public var model: String
    public var targetLanguage: String
    public var unloadLocalModelAfterResponse: Bool

    public init(
        provider: ModelProviderKind,
        baseURL: URL,
        model: String,
        targetLanguage: String,
        unloadLocalModelAfterResponse: Bool
    ) {
        self.provider = provider
        self.baseURL = baseURL
        self.model = model
        self.targetLanguage = targetLanguage
        self.unloadLocalModelAfterResponse = unloadLocalModelAfterResponse
    }

    public var requiresToken: Bool {
        switch provider {
        case .openRouter, .gemini:
            return true
        case .openAICompatible:
            return !baseURL.isLoopbackHTTP
        case .ollama, .lmStudio:
            return false
        }
    }

    public static func preset(_ preset: ModelPreset) -> ModelConfiguration {
        switch preset {
        case .ollama:
            return ModelConfiguration(
                provider: .ollama,
                baseURL: URL(string: "http://127.0.0.1:11434")!,
                model: "qwen3:0.6b",
                targetLanguage: "简体中文",
                unloadLocalModelAfterResponse: true
            )
        case .lmStudio:
            return ModelConfiguration(
                provider: .lmStudio,
                baseURL: URL(string: "http://127.0.0.1:1234/v1")!,
                model: "ibm/granite-4-micro",
                targetLanguage: "简体中文",
                unloadLocalModelAfterResponse: false
            )
        case .openRouter:
            return ModelConfiguration(
                provider: .openRouter,
                baseURL: URL(string: "https://openrouter.ai/api/v1")!,
                model: "openrouter/free",
                targetLanguage: "简体中文",
                unloadLocalModelAfterResponse: false
            )
        case .gemini:
            return ModelConfiguration(
                provider: .gemini,
                baseURL: URL(string: "https://generativelanguage.googleapis.com/v1beta/openai")!,
                model: "gemini-3.7-flash",
                targetLanguage: "简体中文",
                unloadLocalModelAfterResponse: false
            )
        }
    }
}

extension URL {
    var isLoopbackHTTP: Bool {
        guard scheme?.lowercased() == "http" else { return false }
        switch host?.lowercased() {
        case "localhost", "127.0.0.1", "::1":
            return true
        default:
            return false
        }
    }
}
