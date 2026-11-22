import ExpoModulesCore

/// JavaScript's side of CallCoordinator. See src/index.ts for what each call is for.
public class CallsExpoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CallsExpo")

    Events(
      "onVoipToken", "onIncomingCall", "onAnswer", "onEnd", "onMute",
      "onReset", "onAudioActivated", "onAudioDeactivated"
    )

    OnStartObserving {
      CallCoordinator.shared.emit = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnStopObserving {
      CallCoordinator.shared.emit = nil
    }

    Function("getVoipToken") { () -> String? in
      CallCoordinator.shared.voipToken
    }

    AsyncFunction("reportIncomingCall") { (callId: String, name: String?, promise: Promise) in
      CallCoordinator.shared.reportIncoming(callId: callId, name: name) { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("startOutgoingCall") { (callId: String, name: String?, promise: Promise) in
      CallCoordinator.shared.startOutgoing(callId: callId, name: name) { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("reportOutgoingConnected") { (callId: String) in
      CallCoordinator.shared.reportOutgoingConnected(callId: callId)
    }.runOnQueue(.main)

    AsyncFunction("endCall") { (callId: String, reason: String) in
      CallCoordinator.shared.end(callId: callId, reason: reason)
    }.runOnQueue(.main)

    AsyncFunction("setMuted") { (callId: String, muted: Bool) in
      CallCoordinator.shared.setMuted(callId: callId, muted: muted)
    }.runOnQueue(.main)
  }
}
