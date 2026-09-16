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
  private var interruptionObserver: NSObjectProtocol?

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

    /// Fired when iOS takes the audio session away mid-recording -- an
    /// incoming call, Siri, another app claiming the microphone. The app
    /// cannot carry on recording through it, and what it must not do is
    /// pretend nothing happened: that is how a voice message ends up with a
    /// silent hole in it.
    Events("onAudioInterruption")

    /// For playing a voice message: high-quality Bluetooth output (A2DP),
    /// speaker rather than earpiece by default.
    ///
    /// `.playback` rather than `.playAndRecord`, because the record-capable
    /// category routes audio to the receiver at low volume and treats
    /// Bluetooth as a headset rather than as headphones.
    AsyncFunction("configureForPlayback") { [weak self] in
      let session = AVAudioSession.sharedInstance()
      // No options. `.allowBluetoothA2DP` is only accepted with a
      // record-capable category -- with `.playback`, high-quality Bluetooth
      // output is already the default, and passing the option explicitly is
      // an invalid parameter (OSStatus -50), which is what broke recording.
      try session.setCategory(.playback, mode: .default)
      try session.setActive(true)

      // Recording is over (this is the counterpart of configureForRecording),
      // so let the screen sleep on its own schedule again.
      DispatchQueue.main.async {
        UIApplication.shared.isIdleTimerDisabled = false
      }

      if let observer = self?.interruptionObserver {
        NotificationCenter.default.removeObserver(observer)
        self?.interruptionObserver = nil
      }
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
    AsyncFunction("configureForRecording") { [weak self] in
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

      // Hold the screen awake for as long as this lasts.
      //
      // Recording a voice message is the one thing this app does where the
      // person is holding the phone and saying nothing to it for half a
      // minute. iOS counts that as idleness, dims the screen and locks it --
      // and a locked screen puts the app in the background, where the audio
      // session is taken away and the recording stops. Touching the screen
      // woke it and recording carried on, which is worse than stopping
      // outright: the message came out with a hole in the middle that nobody
      // was told about.
      //
      // The alternative would be the `audio` background mode, which keeps
      // recording with the screen off. That is a far larger claim to make of
      // an app -- it is reviewed as such, and it means the microphone can run
      // when nobody can see that it is running. Keeping the screen lit while
      // the finger is on the button says exactly what is happening.
      //
      // iOS clears this by itself when the app leaves the foreground, so a
      // recording interrupted some other way cannot leave the screen pinned
      // awake for ever.
      DispatchQueue.main.async {
        UIApplication.shared.isIdleTimerDisabled = true
      }

      if self?.interruptionObserver == nil {
        self?.interruptionObserver = NotificationCenter.default.addObserver(
          forName: AVAudioSession.interruptionNotification,
          object: nil,
          queue: .main
        ) { [weak self] notification in
          guard
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw),
            type == .began
          else { return }
          // Only the beginning is reported. Resuming is not offered on
          // purpose: audio recorded after a gap is still a message with a gap,
          // and the person has no way of knowing what was lost. Ending it and
          // saying so leaves them able to decide.
          self?.sendEvent("onAudioInterruption", [:])
        }
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
