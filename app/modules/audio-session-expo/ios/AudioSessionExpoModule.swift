import ExpoModulesCore
import AVFoundation
import UIKit

/**
 Direct control over `AVAudioSession`.

 expo-audio offers `allowsRecording` and nothing else, which is not enough for
 two things people expect from voice messages:

 - **Recording through Bluetooth headphones.** The microphone on AirPods is
   only available when the session allows the hands-free profile
   (`.allowBluetooth`). Without it, iOS records from the phone regardless of
   what is connected -- or, as reported here, does not record at all.

 - **Holding the phone to your ear.** iOS does not do this by itself; an app
   has to watch the proximity sensor and move the output to the receiver when
   the phone is against a face, then back to the speaker afterwards.

 Both are session-level concerns, so all of it lives here rather than being
 approximated from JavaScript.
 */
public class AudioSessionExpoModule: Module {
  private var proximityObserver: NSObjectProtocol?
  private var routeObserver: NSObjectProtocol?

  /// Outputs that mean the person is listening through something other than
  /// the phone itself. When one is active, the phone's own routing -- speaker,
  /// receiver, proximity sensor -- must stay out of the way entirely.
  private static let externalOutputs: Set<AVAudioSession.Port> = [
    .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
    .headphones, .airPlay, .carAudio, .usbAudio, .HDMI, .lineOut,
  ]

  private static func hasExternalOutput() -> Bool {
    AVAudioSession.sharedInstance().currentRoute.outputs.contains {
      externalOutputs.contains($0.portType)
    }
  }

  /// Decides where a voice message plays, right now.
  ///
  /// Headphones win over everything. This is the rule 1.7.1 broke: it asked
  /// for the speaker unconditionally at the start of every message, and
  /// `overrideOutputAudioPort(.speaker)` beats a Bluetooth route -- so with
  /// AirPods in, voice messages came out of the phone. The override is now
  /// only ever applied when there is no external output to respect, and
  /// `.none` is used otherwise, which leaves iOS on the headphones.
  ///
  /// Without headphones: the receiver while the phone is at the ear, the
  /// speaker otherwise.
  private static func applyPlaybackRoute() {
    let session = AVAudioSession.sharedInstance()
    let external = hasExternalOutput()

    // The proximity sensor only matters without headphones. Left on while
    // wearing AirPods, it blanks the screen for no reason whenever the phone
    // is near anything.
    UIDevice.current.isProximityMonitoringEnabled = !external

    if external {
      try? session.overrideOutputAudioPort(.none)
      return
    }
    let nearEar = UIDevice.current.proximityState
    try? session.overrideOutputAudioPort(nearEar ? .none : .speaker)
  }

  public func definition() -> ModuleDefinition {
    Name("AudioSessionExpo")

    /// For playing a voice message: high-quality Bluetooth output (A2DP),
    /// speaker rather than earpiece by default.
    ///
    /// `.playback` rather than `.playAndRecord`, because the record-capable
    /// category routes audio to the receiver at low volume and treats
    /// Bluetooth as a headset rather than as headphones.
    AsyncFunction("configureForPlayback") {
      let session = AVAudioSession.sharedInstance()
      // No options. `.allowBluetoothA2DP` is only accepted with a
      // record-capable category -- with `.playback`, high-quality Bluetooth
      // output is already the default, and passing the option explicitly is
      // an invalid parameter (OSStatus -50), which is what broke recording.
      try session.setCategory(.playback, mode: .default)
      try session.setActive(true)
    }

    /// For recording: `.playAndRecord` with the hands-free profile allowed,
    /// which is what makes a Bluetooth microphone usable at all.
    ///
    /// Must be called AFTER the expo-audio recorder is created, never before.
    /// expo-audio's `AudioRecorder` initialiser calls
    /// `setCategory(.playAndRecord, mode: .default)` with no options
    /// (node_modules/expo-audio/ios/AudioRecorder.swift), which silently
    /// discards `.allowBluetooth`. Calling this first -- as the app did until
    /// now -- meant the option was wiped a moment later, and the AirPods
    /// microphone was never reachable.
    AsyncFunction("configureForRecording") {
      let session = AVAudioSession.sharedInstance()
      // `.defaultToSpeaker` is dropped: nothing is played while recording, and
      // forcing the speaker fights the Bluetooth route this exists to enable.
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.allowBluetooth, .allowBluetoothA2DP]
      )
      try session.setActive(true)

      // Ask for the headset microphone by name when one is there, rather than
      // trusting iOS to pick it. With both Bluetooth options set it usually
      // does, but "usually" is how this feature stayed broken unnoticed. A
      // failure here is not fatal: the phone's own microphone still records.
      if let headset = session.availableInputs?.first(where: {
        $0.portType == .bluetoothHFP || $0.portType == .bluetoothLE
      }) {
        try? session.setPreferredInput(headset)
      }
    }

    /// Starts routing a voice message the way every messenger does:
    /// headphones if connected; otherwise the speaker, moving to the receiver
    /// while the phone is held to the ear.
    ///
    /// A record-capable category is needed because `.playback` cannot address
    /// the receiver at all. `.allowBluetoothA2DP` keeps Bluetooth output at
    /// full quality.
    AsyncFunction("startEarpieceRouting") { [weak self] in
      let session = AVAudioSession.sharedInstance()
      // No `.defaultToSpeaker`: that option redefines the category's default
      // route as the speaker, which makes `overrideOutputAudioPort(.none)`
      // mean "back to the speaker" rather than "back to the receiver", and
      // the earpiece becomes unreachable. The speaker is asked for explicitly
      // in applyPlaybackRoute instead, and only when no headphones are in use.
      try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
      try session.setActive(true)

      DispatchQueue.main.async {
        AudioSessionExpoModule.applyPlaybackRoute()
      }

      guard let self else { return }

      if self.proximityObserver == nil {
        self.proximityObserver = NotificationCenter.default.addObserver(
          forName: UIDevice.proximityStateDidChangeNotification,
          object: nil,
          queue: .main
        ) { _ in
          AudioSessionExpoModule.applyPlaybackRoute()
        }
      }

      // AirPods going in or coming out mid-message. Without this, taking them
      // out would leave playback on the receiver at call volume, and putting
      // them in would leave it on the speaker.
      if self.routeObserver == nil {
        self.routeObserver = NotificationCenter.default.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: nil,
          queue: .main
        ) { _ in
          AudioSessionExpoModule.applyPlaybackRoute()
        }
      }
    }

    /// Stops playback routing and turns the proximity sensor off. Leaving it
    /// on blanks the screen whenever anything comes near the phone, which is
    /// alarming in an app that is not on a call.
    AsyncFunction("stopEarpieceRouting") { [weak self] in
      if let observer = self?.proximityObserver {
        NotificationCenter.default.removeObserver(observer)
        self?.proximityObserver = nil
      }
      if let observer = self?.routeObserver {
        NotificationCenter.default.removeObserver(observer)
        self?.routeObserver = nil
      }
      DispatchQueue.main.async {
        UIDevice.current.isProximityMonitoringEnabled = false
      }
      // `.none`, not `.speaker`: nothing is playing any more, and forcing the
      // speaker here would override headphones for whatever uses the session
      // next.
      try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.none)
    }
  }
}
