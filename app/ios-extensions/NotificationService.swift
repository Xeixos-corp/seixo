import UserNotifications

/**
 Adds one to the app icon badge for every notification that arrives, while the
 app itself is not running.

 A Notification Service Extension is a separate, short-lived process that iOS
 starts for a push marked `mutable-content` (supabase/migrations/0022). It
 cannot see the app's messages or keys, and it does not need to: it only
 counts. The count starts from the number the app last stored in the shared
 App Group (modules/shared-badge-expo), which is the real unread total, so the
 two agree whenever the app has been opened since.

 It never changes what the notification says. The text is still the generic
 one the device chose, and nothing here is sent anywhere.

 `@objc(NotificationService)` matters: expo-nse-plugin writes
 `NSExtensionPrincipalClass = NotificationService` with no module prefix, and
 without an explicit Objective-C name iOS would not find a Swift class under
 that name, and would deliver the notification without ever running this.
 */
@objc(NotificationService)
class NotificationService: UNNotificationServiceExtension {
  /// Must match SharedBadgeExpoModule.countKey.
  private static let countKey = "seixo.badge.count"

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler

    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    bestAttempt = content

    // The group is set per build variant and injected into this extension's
    // Info.plist by app.config.js, so Seixo and Seixo Dev never share a count.
    if let group = Bundle.main.object(forInfoDictionaryKey: "SeixoAppGroup") as? String,
       let shared = UserDefaults(suiteName: group) {
      let next = shared.integer(forKey: NotificationService.countKey) + 1
      shared.set(next, forKey: NotificationService.countKey)
      content.badge = NSNumber(value: next)
    }

    contentHandler(content)
  }

  /// Called if iOS is about to kill the extension before it finished. Deliver
  /// what there is rather than let the notification be dropped.
  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let bestAttempt {
      contentHandler(bestAttempt)
    }
  }
}
