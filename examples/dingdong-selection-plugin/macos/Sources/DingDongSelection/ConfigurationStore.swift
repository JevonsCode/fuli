import Foundation
import SelectionCore

final class ConfigurationStore {
    private let defaults: UserDefaults
    private let key = "model-configuration-v1"
    private let pluginStateKey = "selection-plugin-state-v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> ModelConfiguration {
        guard let data = defaults.data(forKey: key),
              let configuration = try? JSONDecoder().decode(ModelConfiguration.self, from: data) else {
            return .preset(.ollama)
        }
        return configuration
    }

    func save(_ configuration: ModelConfiguration) throws {
        defaults.set(try JSONEncoder().encode(configuration), forKey: key)
    }

    func loadPluginState() -> DingDongPluginState {
        guard let rawValue = defaults.string(forKey: pluginStateKey),
              let state = DingDongPluginState(rawValue: rawValue) else {
            return .enabled
        }
        return state
    }

    func savePluginState(_ state: DingDongPluginState) {
        defaults.set(state.rawValue, forKey: pluginStateKey)
    }
}
