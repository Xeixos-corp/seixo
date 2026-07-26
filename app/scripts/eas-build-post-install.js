// EAS Build lifecycle hook (see package.json "eas-build-post-install"):
// https://docs.expo.dev/build-reference/npm-hooks/
// Runs after `npm install` + `expo prebuild` + (for iOS) `pod install`.
// Android's Rust cross-compilation already happens locally (cargo-ndk, see
// packages/signal-native-rn... — no, see app/modules/signal-native-expo and
// packages/signal-native/README.md) and its .so files are already checked
// into the Expo Module's jniLibs, so nothing to do here for Android.
//
// iOS can only be cross-compiled on a Mac (no Apple SDK on Windows), so that
// build has to happen here, on EAS Build's macOS workers, once per build.
// NOT YET RUN — see packages/signal-native/rust/build-ios.sh for the
// caveats; this is the first real execution path for it.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.env.EAS_BUILD_PLATFORM !== 'ios') {
  process.exit(0);
}

const scriptPath = path.join(__dirname, '..', '..', 'packages', 'signal-native', 'rust', 'build-ios.sh');

console.log(`[eas-build-post-install] Building signal-native for iOS via ${scriptPath}`);
execFileSync('bash', [scriptPath], { stdio: 'inherit' });
