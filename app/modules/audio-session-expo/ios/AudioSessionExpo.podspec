Pod::Spec.new do |s|
  s.name           = 'AudioSessionExpo'
  s.version        = '1.0.0'
  s.summary        = 'Direct control over AVAudioSession, which expo-audio does not expose'
  s.description    = 'Recording over Bluetooth and earpiece routing both need audio session options expo-audio has no API for. See docs/threat-model.md.'
  s.author         = 'Seixo'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # Same minimum as SignalNativeExpo and as Expo SDK 52 itself. A mismatch
  # here is what once made CocoaPods silently skip a local pod entirely --
  # see that module's podspec comment.
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { path: '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.swift"
end
