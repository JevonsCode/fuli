import Foundation
import Security

enum KeychainTokenError: Error, LocalizedError {
    case unexpectedStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case let .unexpectedStatus(status):
            return "无法访问 macOS 钥匙串（\(status)）。"
        }
    }
}

final class KeychainTokenStore {
    private let service = "com.dingdong.selection-assistant.model-token"

    func containsToken(account: String) -> Bool {
        (try? load(account: account)) != nil
    }

    func load(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw KeychainTokenError.unexpectedStatus(status)
        }
        return value.isEmpty ? nil : value
    }

    func save(_ token: String, account: String) throws {
        let data = Data(token.utf8)
        let query = baseQuery(account: account)
        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            ] as CFDictionary
        )
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainTokenError.unexpectedStatus(updateStatus)
        }

        var addition = query
        addition[kSecValueData as String] = data
        addition[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(addition as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainTokenError.unexpectedStatus(addStatus)
        }
    }

    func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainTokenError.unexpectedStatus(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
