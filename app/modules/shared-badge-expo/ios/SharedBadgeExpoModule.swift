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
  }
}
