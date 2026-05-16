/*
 * GlobalHotKeys — system-wide keyboard shortcuts via Carbon's
 * RegisterEventHotKey. SwiftUI / AppKit don't expose a global-hotkey
 * API; Carbon's still the canonical path on macOS 26.
 *
 * Today's bindings:
 *   ⌘⌃P → toggle the floating pet window
 *
 * Adding more: call GlobalHotKeys.shared.register(keyCode:modifiers:)
 * with an action closure. Each registration returns an id that can be
 * passed back to unregister.
 */

import AppKit
import Carbon.HIToolbox

@MainActor
final class GlobalHotKeys {
    static let shared = GlobalHotKeys()

    private var handlers: [UInt32: () -> Void] = [:]
    private var hotKeyRefs: [UInt32: EventHotKeyRef] = [:]
    private var nextId: UInt32 = 1
    private var eventHandlerInstalled = false

    /// Wire the default Detour shortcuts. Called once from AppDelegate.
    func installDefaults() {
        register(keyCode: UInt32(kVK_ANSI_P),
                 modifiers: UInt32(cmdKey | controlKey),
                 action: { [weak self] in self?.togglePet() })
    }

    @discardableResult
    func register(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) -> UInt32 {
        installEventHandlerIfNeeded()
        let id = nextId
        nextId += 1
        handlers[id] = action

        var hotKeyRef: EventHotKeyRef?
        var hotKeyID = EventHotKeyID(signature: 0x44_45_54_52 /* "DETR" */, id: id)
        let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID,
                                          GetEventDispatcherTarget(),
                                          0,
                                          &hotKeyRef)
        if status == noErr, let ref = hotKeyRef {
            hotKeyRefs[id] = ref
        } else {
            NSLog("[hotkey] RegisterEventHotKey failed: status=\(status)")
            handlers.removeValue(forKey: id)
        }
        return id
    }

    func unregister(_ id: UInt32) {
        if let ref = hotKeyRefs.removeValue(forKey: id) {
            UnregisterEventHotKey(ref)
        }
        handlers.removeValue(forKey: id)
    }

    private func installEventHandlerIfNeeded() {
        if eventHandlerInstalled { return }
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, eventRef, _) -> OSStatus in
                guard let eventRef = eventRef else { return OSStatus(eventNotHandledErr) }
                var hotKeyID = EventHotKeyID()
                GetEventParameter(eventRef,
                                  EventParamName(kEventParamDirectObject),
                                  EventParamType(typeEventHotKeyID),
                                  nil,
                                  MemoryLayout<EventHotKeyID>.size,
                                  nil,
                                  &hotKeyID)
                let id = hotKeyID.id
                Task { @MainActor in
                    GlobalHotKeys.shared.fire(id: id)
                }
                return noErr
            },
            1,
            &eventType,
            nil,
            nil,
        )
        eventHandlerInstalled = true
    }

    private func fire(id: UInt32) {
        handlers[id]?()
    }

    // MARK: - Default actions

    private func togglePet() {
        let alreadyOpen = NSApp.windows.contains { $0.title == "Detour Pet" && $0.isVisible }
        if alreadyOpen {
            WindowFactory.shared.closePet()
        } else {
            WindowFactory.shared.openPet()
        }
    }
}
