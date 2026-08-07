// EAS Build lifecycle hook (see package.json "eas-build-post-install"):
// https://docs.expo.dev/build-reference/npm-hooks/
//
// Distinct from and complementary to eas-build-pre-install.js (which builds
// the Rust xcframework *before* `npm install`/`pod install`, see that
// file's comment for the hook-ordering bug it fixes). This one deliberately
// needs to run *after* `pod install`, since it patches a file that only
// exists once CocoaPods has actually vendored the `fmt` pod
// (ios/Pods/fmt/include/fmt/base.h) -- there'd be nothing to patch any
// earlier in the pipeline.
//
// What this fixes: Xcode 26's Clang enforces stricter C++20 `consteval`
// rules than the `fmt` 11.0.2 pod (pulled in transitively via RCT-Folly on
// this React Native version, 0.76.9) satisfies -- `pod install` succeeds,
// but the actual Xcode archive step fails with errors like:
//   call to consteval function 'fmt::basic_format_string<...>' is not a
//   constant expression
// Fixed upstream in fmt 12.1.0 (React Native >= 0.83.9 / Expo SDK 56), well
// past this project's SDK 52.
//
// A first attempt tried to fix this via a Podfile post_install override
// (an Expo config plugin setting CLANG_CXX_LANGUAGE_STANDARD=c++17 on just
// the 'fmt' pod target) -- `pod install` succeeded, but the error persisted
// unchanged at the Xcode-archive step. Most likely cause: React Native's
// own `react_native_post_install` helper (called from the same Podfile
// block) also normalizes C++ language-standard build settings across pods,
// and since it's very plausible that helper's own pass runs after or
// otherwise supersedes a plain per-target Ruby override, our setting never
// actually reached the compiler. Rather than fight over post_install
// ordering/precedence, this patches the actual header text instead, which
// has no such ambiguity: see
// https://bleepingswift.com/blog/fmt-consteval-error-xcode-26-4-react-native
// and docs/threat-model.md's "App Store submission needs a newer EAS build
// image" follow-up for the full story.
//
// The patch: flip fmt's own FMT_USE_CONSTEVAL feature-detection so it never
// enables the consteval code path on Apple's Clang specifically (detected
// via the `__apple_build_version__` macro, which Apple's clang forks define
// and upstream/GCC do not) -- `fmt` then falls back to its ordinary
// (working) `constexpr`-based format-string validation instead.
//
// Remove this whole hook once the project upgrades past React Native
// 0.83.9 / Expo SDK 56, at which point fmt itself no longer needs it.

const fs = require('node:fs');
const path = require('node:path');

if (process.env.EAS_BUILD_PLATFORM !== 'ios') {
  process.exit(0);
}

const fmtBaseHeaderPath = path.join(__dirname, '..', 'ios', 'Pods', 'fmt', 'include', 'fmt', 'base.h');

if (!fs.existsSync(fmtBaseHeaderPath)) {
  console.log(
    `[eas-build-post-install] ${fmtBaseHeaderPath} not found -- nothing to patch (fmt pod not installed, or its layout changed).`
  );
  process.exit(0);
}

const original = fs.readFileSync(fmtBaseHeaderPath, 'utf8');
const alreadyPatchedMarker = '!defined(__apple_build_version__)';

if (original.includes(alreadyPatchedMarker)) {
  console.log('[eas-build-post-install] fmt/base.h already patched -- skipping.');
  process.exit(0);
}

// Exact text confirmed against fmt 11.0.2's include/fmt/base.h. If this
// project's fmt version ever changes, this string may no longer match --
// fail loudly rather than silently shipping a build with the unpatched
// (and known-broken, on Xcode 26) consteval path.
const target = '#elif defined(__cpp_consteval)';
if (!original.includes(target)) {
  console.error(
    `[eas-build-post-install] Could not find "${target}" in fmt/base.h -- the fmt version bundled by this project may have changed. This patch (app/scripts/eas-build-post-install.js) needs updating to match, or may no longer be necessary at all (fmt >= 12.1.0 fixed this upstream) -- check before removing.`
  );
  process.exit(1);
}

const patched = original.replace(target, `${target} && !defined(__apple_build_version__)`);
fs.writeFileSync(fmtBaseHeaderPath, patched);
console.log(
  '[eas-build-post-install] Patched fmt/base.h: disabled FMT_USE_CONSTEVAL on Apple Clang (Xcode 26 consteval-vs-fmt-11.0.2 incompatibility workaround).'
);
