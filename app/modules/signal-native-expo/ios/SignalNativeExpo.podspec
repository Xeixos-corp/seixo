Pod::Spec.new do |s|
  s.name           = 'SignalNativeExpo'
  s.version        = '1.0.0'
  s.summary        = 'Expo Module bridging the signal-native Rust crate (libsignal-protocol)'
  s.description    = 'See packages/signal-native/README.md and this module\'s ios/generated/ for the uniffi-generated Swift bindings this wraps.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Only Swift here — the C header for the Rust FFI (signal_nativeFFI.h)
  # ships inside SignalNative.xcframework's headers instead of being loose
  # source, so it isn't picked up twice.
  s.source_files = "*.swift", "generated/*.swift"

  # Built by build-ios.sh (NOT run yet — no Mac available locally; runs via
  # the `eas-build-post-install` hook on EAS Build's macOS workers, see
  # app/package.json). Xcode will fail to find this until that has run once.
  s.vendored_frameworks = 'SignalNative.xcframework'
end
