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
      try session.setCategory(.playback, mode: .default, options: [.allowBluetoothA2DP])
      try session.setActive(true)
    }

    /// For recording: `.playAndRecord` with the hands-free profile allowed,
    /// which is what makes a Bluetooth microphone usable at all.
    ///
    /// `.allowBluetooth` costs audio quality on the output side -- the
    /// hands-free profile is narrowband -- but nothing is being played while
    /// recording, and it is the only way to reach the microphone on AirPods.
    AsyncFunction("configureForRecording") {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
      )
      try session.setActive(true)
    }

    /// Starts moving playback to the earpiece while the phone is held to the
    /// ear, the way every messenger behaves.
    ///
    /// Only meaningful with a record-capable category, since `.playback`
    /// cannot address the receiver at all -- hence the category change here.
    /// Bluetooth output stays available, and iOS keeps using it when
    /// headphones are connected: the proximity sensor is not triggered by a
    /// phone in a pocket while someone wears AirPods.
    AsyncFunction("startEarpieceRouting") { [weak self] in
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.allowBluetoothA2DP, .defaultToSpeaker]
      )
      try session.setActive(true)

      DispatchQueue.main.async {
        UIDevice.current.isProximityMonitoringEnabled = true
      }

      guard self?.proximityObserver == nil else { return }
      self?.proximityObserver = NotificationCenter.default.addObserver(
        forName: UIDevice.proximityStateDidChangeNotification,
        object: nil,
        queue: .main
      ) { _ in
        let nearEar = UIDevice.current.proximityState
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(nearEar ? .none : .speaker)
      }
    }

    /// Stops proximity routing and turns the sensor off. Leaving it on blanks
    /// the screen whenever anything comes near the phone, which is alarming
    /// in an app that is not on a call.
    AsyncFunction("stopEarpieceRouting") { [weak self] in
      if let observer = self?.proximityObserver {
        NotificationCenter.default.removeObserver(observer)
        self?.proximityObserver = nil
      }
      DispatchQueue.main.async {
        UIDevice.current.isProximityMonitoringEnabled = false
      }
      try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
    }
  }
}
