import ExpoModulesCore
import UIKit

/// Starts listening for VoIP pushes as the app launches -- including the
/// launches iOS makes in the background to deliver one, before any
/// JavaScript has run.
public class CallsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CallCoordinator.shared.start()
    return true
  }
}
