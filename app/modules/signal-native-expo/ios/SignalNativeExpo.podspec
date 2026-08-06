Pod::Spec.new do |s|
  s.name           = 'SignalNativeExpo'
  s.version        = '1.0.0'
  s.summary        = 'Expo Module bridging the signal-native Rust crate (libsignal-protocol)'
  s.description    = 'See packages/signal-native/README.md and this module\'s ios/generated/ for the uniffi-generated Swift bindings this wraps.'
  s.author         = 'Seixo'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # Match Expo SDK 52 / React Native 0.76's own minimum iOS target (15.1) --
  # this podspec previously required 16.4 for no concrete reason (nothing in
  # SignalNativeExpoModule.swift or the uniffi-generated bindings needs
  # anything past basic Swift/Codable), a real mismatch against the rest of
  # the project that's a plausible reason CocoaPods silently excluded this
  # pod from "pod install" — see docs/threat-model.md's "Native crypto
  # module autolinking" entry. Not dropping :tvos since this project
  # doesn't target tvOS at all.
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { path: '.' }
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

  # Built by build-ios.sh, run via the `eas-build-pre-install` hook on EAS
  # Build's macOS workers (see app/package.json) — must run before this
  # podspec is resolved by CocoaPods, which is why that hook runs before
  # `npm install`/`pod install`, not after.
  s.vendored_frameworks = 'SignalNative.xcframework'
end
