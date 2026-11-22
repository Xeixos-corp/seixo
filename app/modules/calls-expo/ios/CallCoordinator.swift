import AVFoundation
import CallKit
import PushKit
import UIKit

/**
 Everything about calls that iOS insists on handling natively.

 A VoIP push can wake the app when it is not running at all, and iOS requires
 that every such push is reported to CallKit as an incoming call *before* the
 push handler returns. An app that fails to do so is terminated, and after a
 few failures iOS stops delivering its VoIP pushes altogether. JavaScript may
 not even be loaded at that point, so this cannot wait for it: the call is
 shown here, at once, under a neutral name ("Seixo"), and JavaScript is told
 afterwards. It names the caller once it has decrypted the call's offer.

 The push carries only the call's id, a random number made on the caller's
 phone. Not who is calling, not the conversation: Apple delivers it, and the
 push is all Apple sees.
 */
final class CallCoordinator: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = CallCoordinator()

  private let provider: CXProvider
  private let controller = CXCallController()
  private var registry: PKPushRegistry?

  /// The latest VoIP token, hex. Empty when iOS has withdrawn it.
  private(set) var voipToken: String?

  /// Set by the module while JavaScript is listening; events before that are queued.
  var emit: ((String, [String: Any]) -> Void)? {
    // Not at once: Expo calls OnStartObserving when the first listener is
    // added, before the others are. Flushing then delivered a queued event to
    // nobody -- the VoIP token on first launch, and it would have been an
    // answer from the lock screen. Half a second lets them all attach.
    didSet { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.flush() } }
  }
  private var queued: [(String, [String: Any])] = []

  /// Calls reported to CallKit and not yet ended, by call id.
  private var active: [String: UUID] = [:]

  private override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = false
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    // Calls are not written to the Phone app's Recents. Recents sync through
    // iCloud to every device on the account, which would put "a Seixo call at
    // 21:14" somewhere outside this app, and outside its disappearing timers.
    config.includesCallsInRecents = false
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  /// Registers for VoIP pushes. Called at launch, so a push that woke the
  /// app finds the registry already listening.
  func start() {
    guard registry == nil else { return }
    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
  }

  // MARK: - Events to JavaScript

  private func send(_ name: String, _ body: [String: Any] = [:]) {
    DispatchQueue.main.async {
      if let emit = self.emit {
        emit(name, body)
      } else {
        self.queued.append((name, body))
      }
    }
  }

  private func flush() {
    guard let emit else { return }
    let pending = queued
    queued.removeAll()
    pending.forEach { emit($0.0, $0.1) }
  }

  // MARK: - Ids

  /// A call id is 32 hex characters, which is exactly a UUID. Using it as the
  /// CallKit UUID means the push and the decrypted offer name the same call
  /// without any table to keep in step.
  static func uuid(for callId: String) -> UUID? {
    let hex = callId.lowercased().filter { $0.isHexDigit }
    guard hex.count == 32 else { return nil }
    let chars = Array(hex)
    let parts = [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { String(chars[$0]) }
    return UUID(uuidString: parts.joined(separator: "-"))
  }

  private func callId(for uuid: UUID) -> String {
    active.first(where: { $0.value == uuid })?.key ?? uuid.uuidString.replacingOccurrences(of: "-", with: "").lowercased()
  }

  private func neutralUpdate(name: String?) -> CXCallUpdate {
    let update = CXCallUpdate()
    let shown = (name?.isEmpty == false ? name! : "Seixo")
    update.remoteHandle = CXHandle(type: .generic, value: shown)
    update.localizedCallerName = shown
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    return update
  }

  // MARK: - Called from JavaScript

  /// An incoming call found by JavaScript (the offer arrived while the app
  /// was open, so no push was needed), or the caller's name for a call the
  /// push already reported.
  func reportIncoming(callId: String, name: String?, completion: @escaping (Bool) -> Void) {
    guard let uuid = Self.uuid(for: callId) else { return completion(false) }
    if active[callId] != nil {
      provider.reportCall(with: uuid, updated: neutralUpdate(name: name))
      return completion(true)
    }
    active[callId] = uuid
    provider.reportNewIncomingCall(with: uuid, update: neutralUpdate(name: name)) { error in
      if error != nil { self.active.removeValue(forKey: callId) }
      completion(error == nil)
    }
  }

  /// A call this phone places. Going through CallKit makes iOS treat it as a
  /// phone call: the audio session gets call priority, and the green
  /// indicator shows a call is on.
  func startOutgoing(callId: String, name: String?, completion: @escaping (Bool) -> Void) {
    guard let uuid = Self.uuid(for: callId) else { return completion(false) }
    active[callId] = uuid
    let handle = CXHandle(type: .generic, value: (name?.isEmpty == false ? name! : "Seixo"))
    let action = CXStartCallAction(call: uuid, handle: handle)
    action.isVideo = false
    controller.request(CXTransaction(action: action)) { error in
      if error != nil { self.active.removeValue(forKey: callId) }
      completion(error == nil)
    }
  }

  func reportOutgoingConnected(callId: String) {
    guard let uuid = active[callId] else { return }
    provider.reportOutgoingCall(with: uuid, connectedAt: Date())
  }

  /// Ends a call in CallKit. `reason` says who ended it: "local" when this
  /// phone hung up from the app's own screen, anything else when it ended
  /// on the other side or by itself.
  func end(callId: String, reason: String) {
    guard let uuid = active.removeValue(forKey: callId) else { return }
    if reason == "local" {
      controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in }
      return
    }
    let mapped: CXCallEndedReason
    switch reason {
    case "unanswered": mapped = .unanswered
    case "declined": mapped = .declinedElsewhere
    case "failed": mapped = .failed
    default: mapped = .remoteEnded
    }
    provider.reportCall(with: uuid, endedAt: Date(), reason: mapped)
  }

  func setMuted(callId: String, muted: Bool) {
    guard let uuid = active[callId] else { return }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
  }

  // MARK: - PKPushRegistryDelegate

  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    voipToken = token
    send("onVoipToken", ["token": token])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    voipToken = ""
    send("onVoipToken", ["token": ""])
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let callId = (payload.dictionaryPayload["c"] as? String) ?? ""
    // Required by iOS even when the push is unusable: report something, then
    // end it at once, rather than not report and be penalised.
    let uuid = Self.uuid(for: callId) ?? UUID()
    if active[callId] != nil {
      // Already ringing: the offer reached the open app before the push did.
      completion()
      return
    }
    active[callId] = uuid
    provider.reportNewIncomingCall(with: uuid, update: neutralUpdate(name: nil)) { error in
      if error != nil {
        self.active.removeValue(forKey: callId)
      } else if Self.uuid(for: callId) == nil {
        self.end(callId: callId, reason: "failed")
      } else {
        self.send("onIncomingCall", ["callId": callId])
      }
      completion()
    }
  }

  // MARK: - CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    active.removeAll()
    send("onReset")
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    // Configured, not activated: CallKit activates the session itself and
    // says so in didActivate. Activating it here as well is a known way to
    // end up with a call that has no sound.
    try? AVAudioSession.sharedInstance().setCategory(
      .playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    try? AVAudioSession.sharedInstance().setCategory(
      .playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
    send("onAnswer", ["callId": callId(for: action.callUUID)])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let id = callId(for: action.callUUID)
    active.removeValue(forKey: id)
    send("onEnd", ["callId": id])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    send("onMute", ["callId": callId(for: action.callUUID), "muted": action.isMuted])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    send("onAudioActivated")
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    send("onAudioDeactivated")
  }
}
