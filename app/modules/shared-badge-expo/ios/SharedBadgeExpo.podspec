Pod::Spec.new do |s|
  s.name           = 'SharedBadgeExpo'
  s.version        = '1.0.0'
  s.summary        = 'Sets the app icon badge and shares the count with the Notification Service Extension'
  s.description    = 'The extension counts pushes while the app is closed; this keeps its starting point equal to the real unread count.'
  s.author         = 'Seixo'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # Same minimum as SignalNativeExpo, AudioSessionExpo and Expo SDK 52. A
  # mismatch is what once made CocoaPods silently skip a local pod entirely.
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { path: '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UserNotifications'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.swift"
end
