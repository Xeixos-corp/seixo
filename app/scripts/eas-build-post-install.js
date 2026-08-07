// EAS Build lifecycle hook (see package.json "eas-build-post-install"):
// https://docs.expo.dev/build-reference/npm-hooks/
//
// Distinct from and complementary to eas-build-pre-install.js (which builds
// the Rust xcframework *before* `npm install`/`pod install`, see that
// file's comment for the hook-ordering bug it fixes). This one deliberately
// needs to run *after* `pod install`, since the first patch below touches a
// file that only exists once CocoaPods has actually vendored the `fmt` pod
// -- there'd be nothing to patch any earlier in the pipeline. (The second
// patch, on a node_modules file, doesn't strictly need to run this late,
// but there's no benefit to splitting it into a different hook either.)
//
// Both patches here exist for the same underlying reason: Xcode 26 ships a
// meaningfully stricter Clang/Swift toolchain than this project's pinned
// dependency versions (Expo SDK 52 / React Native 0.76.9) were built
// against, and Apple now requires Xcode 26+ for any App Store submission
// (enforced since 2026-04-28 -- see docs/threat-model.md's "App Store
// submission needs a newer EAS build image" follow-up for the full story
// of how this was discovered). A full SDK upgrade would fix both
// properly, but wasn't a reasonable fix to make in the middle of
// debugging a build pipeline -- these are narrow, well-scoped source
// patches instead, each removable once the project upgrades past the
// dependency version that needed it.

const fs = require('node:fs');
const path = require('node:path');

if (process.env.EAS_BUILD_PLATFORM !== 'ios') {
  process.exit(0);
}

/**
 * Apply a list of exact-text patches to a file, in order. Idempotent (skips
 * if `alreadyPatchedMarker` is already present) and fails loudly (non-zero
 * exit) if a target string isn't found, rather than silently shipping an
 * unpatched build -- these are all narrow version-specific workarounds that
 * can easily stop matching after a dependency bump.
 */
function patchFile(label, filePath, alreadyPatchedMarker, patches) {
  if (!fs.existsSync(filePath)) {
    console.log(`[eas-build-post-install] [${label}] ${filePath} not found -- nothing to patch.`);
    return;
  }

  let contents = fs.readFileSync(filePath, 'utf8');

  if (contents.includes(alreadyPatchedMarker)) {
    console.log(`[eas-build-post-install] [${label}] already patched -- skipping.`);
    return;
  }

  for (const { target } of patches) {
    if (!contents.includes(target)) {
      console.error(
        `[eas-build-post-install] [${label}] Could not find "${target}" in ${filePath} -- the ` +
          `bundled version of this dependency may have changed. This patch (app/scripts/eas-build-post-install.js) ` +
          `needs updating to match, or may no longer be necessary at all -- check before removing.`
      );
      process.exit(1);
    }
  }

  for (const { target, replacement } of patches) {
    contents = contents.replace(target, replacement);
  }

  // CocoaPods installs vendored pod sources read-only (to discourage
  // editing them directly) -- confirmed by a real build failing with
  // EACCES the first time this ran against ios/Pods/fmt. node_modules
  // files aren't normally read-only, but chmod'ing them too is harmless.
  fs.chmodSync(filePath, 0o644);
  fs.writeFileSync(filePath, contents);
  console.log(`[eas-build-post-install] [${label}] Patched ${filePath}.`);
}

// --- Patch 1: fmt's FMT_USE_CONSTEVAL vs. Xcode 26's stricter consteval ---
//
// Xcode 26's Clang enforces stricter C++20 `consteval` rules than the `fmt`
// 11.0.2 pod (pulled in transitively via RCT-Folly on this React Native
// version) satisfies -- `pod install` succeeds, but the actual Xcode
// archive step fails with errors like:
//   call to consteval function 'fmt::basic_format_string<...>' is not a
//   constant expression
// Fixed upstream in fmt 12.1.0 (React Native >= 0.83.9 / Expo SDK 56).
//
// A first attempt tried to fix this via a Podfile post_install override
// (an Expo config plugin setting CLANG_CXX_LANGUAGE_STANDARD=c++17 on just
// the 'fmt' pod target) -- `pod install` succeeded, but the error persisted
// unchanged at the Xcode-archive step, most likely because React Native's
// own `react_native_post_install` helper (called from the same Podfile
// block) also normalizes C++ language-standard build settings across pods
// and superseded the plain per-target Ruby override. Patching the header
// text directly instead has no such ordering ambiguity: see
// https://bleepingswift.com/blog/fmt-consteval-error-xcode-26-4-react-native
//
// The patch: flip fmt's own FMT_USE_CONSTEVAL feature-detection so it never
// enables the consteval code path on Apple's Clang specifically (detected
// via the `__apple_build_version__` macro, which Apple's clang forks define
// and upstream/GCC do not) -- `fmt` then falls back to its ordinary
// (working) `constexpr`-based format-string validation instead.
//
// **First version of this patch only touched one of TWO independent
// branches and didn't actually fix anything** -- the archive step failed
// with byte-for-byte the same errors even after it ran. fmt's real
// FMT_USE_CONSTEVAL logic (include/fmt/base.h) is an #if/#elif chain with
// two separate branches that each independently set it to 1:
//   #elif defined(__cpp_consteval)
//   #  define FMT_USE_CONSTEVAL 1
//   #elif FMT_GCC_VERSION >= 1002 || FMT_CLANG_VERSION >= 1101
//   #  define FMT_USE_CONSTEVAL 1
// fmt's FMT_CLANG_VERSION macro (`__clang_major__ * 100 + __clang_minor__`)
// does NOT special-case Apple's clang the way FMT_USE_CONSTEVAL's own
// Apple-version check does elsewhere in the same chain -- it treats Apple
// clang's self-reported version the same as upstream LLVM clang, and
// Xcode 26 reports high enough to satisfy >= 1101 regardless. Confirmed
// fixed once both branches were patched: the archive step got past
// compiling `fmt` (and everything after it, including SignalNativeExpo)
// with zero consteval errors.
//
// Remove once the project upgrades past React Native 0.83.9 / Expo SDK 56.
patchFile(
  'fmt-consteval',
  path.join(__dirname, '..', 'ios', 'Pods', 'fmt', 'include', 'fmt', 'base.h'),
  '!defined(__apple_build_version__)',
  [
    {
      target: '#elif defined(__cpp_consteval)',
      replacement: '#elif defined(__cpp_consteval) && !defined(__apple_build_version__)',
    },
    {
      target: '#elif FMT_GCC_VERSION >= 1002 || FMT_CLANG_VERSION >= 1101',
      replacement:
        '#elif FMT_GCC_VERSION >= 1002 || (FMT_CLANG_VERSION >= 1101 && !defined(__apple_build_version__))',
    },
  ]
);

// --- Patch 2: expo-localization's non-exhaustive Calendar.Identifier switch ---
//
// Xcode 26's Swift compiler enforces exhaustive `switch` over Foundation's
// `Calendar.Identifier` enum more strictly than the version this project's
// pinned `expo-localization` (~16.0.1) was written against -- the archive
// step fails with:
//   switch must be exhaustive
// at `LocalizationModule.swift`'s switch over `calendar.identifier`, which
// only handles the identifiers that existed when that code was written.
// Known, reported upstream: https://github.com/expo/expo/issues/40849
// (affects expo ~52.0.47, Xcode 26.1 -- the same combination this project
// is on). No release of expo-localization compatible with Expo SDK 52 has
// fixed this as of this writing.
//
// The patch: add `@unknown default:` to the switch, Swift's purpose-built
// mechanism for exhaustively handling a non-frozen enum from a system
// framework without enumerating every case -- falls back to "gregory"
// (Gregorian, ISO/BCP-47's calendar default) for any calendar identifier
// added after this file was written.
//
// Remove once expo-localization ships a fix and this project upgrades to
// that version.
patchFile(
  'expo-localization-exhaustive-switch',
  path.join(__dirname, '..', 'node_modules', 'expo-localization', 'ios', 'LocalizationModule.swift'),
  '@unknown default:',
  [
    {
      // Exact indentation (4-space case, 6-space return, 4-space closing
      // brace) confirmed against the actual published expo-localization
      // 16.0.1 package source -- this switch sits inside a static func, one
      // level deeper than a top-level declaration. A first version of this
      // patch assumed 0/2/0-space indentation and never matched, which
      // surfaced immediately as a loud "could not find" failure rather than
      // silently no-op'ing.
      target: '    case .iso8601:\n      return "iso8601"\n    }',
      replacement:
        '    case .iso8601:\n      return "iso8601"\n    @unknown default:\n      return "gregory"\n    }',
    },
  ]
);
