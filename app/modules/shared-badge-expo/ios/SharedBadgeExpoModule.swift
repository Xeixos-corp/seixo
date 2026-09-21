import ExpoModulesCore
import UIKit
import UserNotifications

/**
 Sets the number on the app icon, and keeps a copy where the Notification
 Service Extension can read it.

 The extension (ios-extensions/NotificationService.swift) runs when a push
 arrives, even with the app closed, and adds one to the badge. It cannot see
 the app's messages -- it is a separate process -- so it counts from whatever
 number is stored in the shared App Group. This module writes that number
 every time the app sets the badge, so the extension always continues from the
 real unread count rather than from a number that drifted.

 It also tidies the one other thing that lands in the App Group: photos
 the share extension copied there for the app to pick up.

 Nothing here leaves the phone. The count is never sent anywhere.
 */
public class SharedBadgeExpoModule: Module {
  /// Must match the key read in the Notification Service Extension.
  static let countKey = "seixo.badge.count"

  public func definition() -> ModuleDefinition {
    Name("SharedBadgeExpo")

    AsyncFunction("setBadgeCount") { (count: Int, appGroup: String) in
      let value = max(0, count)
      UserDefaults(suiteName: appGroup)?.set(value, forKey: SharedBadgeExpoModule.countKey)

      if #available(iOS 16.0, *) {
        try await UNUserNotificationCenter.current().setBadgeCount(value)
      } else {
        await MainActor.run {
          UIApplication.shared.applicationIconBadgeNumber = value
        }
      }
    }

    // Deletes photos the share extension copied into the App Group and the
    // app never let go of properly -- because it was closed or crashed
    // between the share and the send. Those copies are originals, location
    // included, and must not accumulate there. Only files named the way the
    // extension names its copies (UUID.ext, at the top level) are touched,
    // and only once they are old enough that no share can still be arriving.
    AsyncFunction("clearSharedFiles") { (appGroup: String, olderThanSeconds: Double) -> Int in
      guard let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup)
      else { return 0 }
      let files = (try? FileManager.default.contentsOfDirectory(
        at: container, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey]))
        ?? []
      let cutoff = Date().addingTimeInterval(-olderThanSeconds)
      var removed = 0
      for file in files {
        let stem = file.deletingPathExtension().lastPathComponent
        guard UUID(uuidString: stem) != nil else { continue }
        let values = try? file.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
        guard values?.isRegularFile == true,
          let modified = values?.contentModificationDate, modified < cutoff
        else { continue }
        if (try? FileManager.default.removeItem(at: file)) != nil { removed += 1 }
      }
      return removed
    }
  }
}
