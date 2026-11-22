Pod::Spec.new do |s|
  s.name           = 'CallsExpo'
  s.version        = '1.0.0'
  s.summary        = 'CallKit and PushKit for voice calls'
  s.description    = 'Reports calls to iOS (CallKit) and receives VoIP pushes (PushKit), which must be handled natively before JavaScript is running.'
  s.author         = 'Seixo'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # Same minimum as the other local modules and as Expo SDK 52 itself.
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { path: '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CallKit', 'PushKit', 'AVFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.swift"
end
