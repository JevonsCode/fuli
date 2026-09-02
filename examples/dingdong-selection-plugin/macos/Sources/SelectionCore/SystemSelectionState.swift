import Foundation

public struct SelectionInputModifiers: OptionSet, Sendable {
    public let rawValue: UInt8

    public init(rawValue: UInt8) {
        self.rawValue = rawValue
    }

    public static let shift = SelectionInputModifiers(rawValue: 1 << 0)
    public static let command = SelectionInputModifiers(rawValue: 1 << 1)
    public static let option = SelectionInputModifiers(rawValue: 1 << 2)
}

public enum SelectionTrigger: Equatable, Sendable {
    case primaryMouseUp
    case accessibilitySelectionChanged
    case keyUp(keyCode: UInt16, modifiers: SelectionInputModifiers)

    public var isDirectCopyShortcut: Bool {
        guard case let .keyUp(keyCode, modifiers) = self else { return false }
        return keyCode == 8 && modifiers.contains([.command, .option])
    }

    public var shouldReadSelection: Bool {
        switch self {
        case .primaryMouseUp, .accessibilitySelectionChanged:
            return true
        case let .keyUp(keyCode, modifiers):
            if isDirectCopyShortcut { return false }
            if keyCode == 0, modifiers.contains(.command) { return true }
            let selectionNavigationKeys: Set<UInt16> = [115, 116, 119, 121, 123, 124, 125, 126]
            return modifiers.contains(.shift) && selectionNavigationKeys.contains(keyCode)
        }
    }
}

public enum SelectionCaptureSource: Equatable, Sendable {
    case focusedApplication
    case observedElement
}

public struct SelectionCaptureScheduleState: Sendable {
    private var scheduledSource: SelectionCaptureSource?

    public init() {}

    public mutating func schedule(_ source: SelectionCaptureSource) {
        scheduledSource = source
    }

    public mutating func consume() -> SelectionCaptureSource? {
        defer { scheduledSource = nil }
        return scheduledSource
    }

    public mutating func cancel() {
        scheduledSource = nil
    }
}

public struct LatestRequestGeneration: Sendable {
    private var value: UInt64 = 0

    public init() {}

    @discardableResult
    public mutating func advance() -> UInt64 {
        value &+= 1
        return value
    }

    public func isCurrent(_ candidate: UInt64) -> Bool {
        candidate == value
    }
}

public struct SelectionEventGeneration: Sendable {
    public private(set) var checkpoint: UInt64 = 0

    public init() {}

    public mutating func recordObservedEvent() {
        checkpoint &+= 1
    }

    public func hasAdvanced(since previousCheckpoint: UInt64) -> Bool {
        checkpoint != previousCheckpoint
    }
}

public enum SelectionElementRole: Sendable {
    case nonSecretTextContainer
    case textField
    case unknown
}

public enum SelectionSecurityPolicy {
    public static func isKnownSubrole(_ subrole: String?) -> Bool {
        guard let subrole,
              !subrole.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        return subrole != "AXUnknown"
    }

    public static func allowsRead(
        attributeListAvailable: Bool,
        role: SelectionElementRole,
        subroleAdvertised: Bool,
        subroleReadSucceeded: Bool,
        isSecureTextField: Bool
    ) -> Bool {
        guard attributeListAvailable else { return false }
        guard role != .unknown else { return false }

        if subroleAdvertised {
            guard subroleReadSucceeded else { return false }
            return !isSecureTextField
        }

        // A text field can be a password field, so an absent subrole is not
        // enough evidence to read it. Text areas, static text, and web areas
        // cannot themselves be secure text fields; a focused password inside
        // a web area is exposed as its own AXTextField element.
        return role == .nonSecretTextContainer
    }
}

public struct SelectionBuffer: Sendable {
    public private(set) var current: String?

    public init() {}

    @discardableResult
    public mutating func update(_ candidate: String) -> Bool {
        guard let normalized = SelectionText.normalize(candidate) else {
            current = nil
            return false
        }
        current = normalized
        return true
    }

    public mutating func consume() -> String? {
        defer { current = nil }
        return current
    }

    public mutating func clear() {
        current = nil
    }
}
