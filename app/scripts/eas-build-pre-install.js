// EAS Build lifecycle hook (see package.json "eas-build-pre-install"):
// https://docs.expo.dev/build-reference/npm-hooks/
//
// IMPORTANT — this used to be named/wired as "eas-build-post-install", which
// is WRONG for what this script needs. Expo's own docs confirm
// eas-build-post-install runs after npm install, expo prebuild, AND
// `pod install` — but our iOS podspec (SignalNativeExpo.podspec) declares
// `s.vendored_frameworks = 'SignalNative.xcframework'`, a file only THIS
// script produces. Running it post-install meant CocoaPods resolved (or
// silently dropped) the pod before the framework ever existed. Discovered
// 2026-08-06 on the first real device run: the app built and installed
// "successfully" but the crypto module was never actually linked in — see
// docs/threat-model.md's "Native crypto module autolinking" entry.
// eas-build-pre-install runs before `npm install`, well before `pod
// install`, which is what this actually needs — Rust/Xcode command line
// tools don't depend on node_modules existing first.
//
// Android's Rust cross-compilation already happens locally (cargo-ndk, see
// app/modules/signal-native-expo and packages/signal-native/README.md) and
// its .so files are already checked into the Expo Module's jniLibs, so
// nothing to do here for Android.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.env.EAS_BUILD_PLATFORM !== 'ios') {
  process.exit(0);
}

const scriptPath = path.join(__dirname, '..', '..', 'packages', 'signal-native', 'rust', 'build-ios.sh');

console.log(`[eas-build-pre-install] Building signal-native for iOS via ${scriptPath}`);
execFileSync('bash', [scriptPath], { stdio: 'inherit' });
