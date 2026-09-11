// Reads app.json and adjusts it for the build variant.
//
// Exists so a development build can live on the phone *alongside* the real
// app instead of replacing it. iOS identifies an app by its bundle
// identifier: installing a development build under the same one overwrites
// the App Store version, and since accounts are anonymous and their keys live
// in the app container, that means losing the identity, the contacts and
// every conversation. Found the hard way on 2026-09-07, when a development
// build could not be installed at all without deleting the app first.
//
// With a distinct identifier the two coexist: "Seixo" with the real identity,
// and "Seixo Dev" beside it with its own. Both talk to the same backend, so
// the development build can hold real conversations with someone running the
// released app -- which is what makes it useful for testing at all.
//
// Set by eas.json's development profiles; absent for production.
const IS_DEV = process.env.APP_VARIANT === 'development';

const base = require('./app.json').expo;

const bundleIdentifier = IS_DEV ? `${base.ios.bundleIdentifier}.dev` : base.ios.bundleIdentifier;

// Everything below is derived from the bundle identifier, so the two variants
// never collide. Two apps answering the same URL scheme would race for every
// shared link, and two apps in the same App Group would share one badge count.
const scheme = IS_DEV ? 'seixo-dev' : 'seixo';
const appGroup = `group.${bundleIdentifier}`;

// The Notification Service Extension that counts the badge while the app is
// closed. expo-nse-plugin names its target this way and gives it the bundle
// identifier `${bundleIdentifier}.${NSE_TARGET}`.
const NSE_TARGET = 'NotificationServiceExtension';

module.exports = () => ({
  ...base,
  name: IS_DEV ? 'Seixo Dev' : base.name,
  // Required by expo-share-intent: the share extension hands its content to
  // the app by opening `${scheme}://dataUrl=...`. Opening the app is all that
  // URL can do -- nothing is read from it except the key of the shared item,
  // and nothing is ever sent without the person pressing send.
  scheme,
  ios: {
    ...base.ios,
    bundleIdentifier,
  },
  android: {
    ...base.android,
    package: IS_DEV ? `${base.android.package}.dev` : base.android.package,
  },
  plugins: [
    ...base.plugins,
    [
      'expo-share-intent',
      {
        // Links and plain text only. Photos and files would need their own
        // decision about how they are encrypted and sent; not part of this.
        iosActivationRules: {
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsText: true,
        },
        iosAppGroupIdentifier: appGroup,
        // iOS only for now: the Android native libraries are out of date with
        // the Rust API and have to be rebuilt before any Android build.
        disableAndroid: true,
      },
    ],
    [
      'expo-nse-plugin',
      {
        // Same value expo-notifications already writes, which is what
        // TestFlight builds have shipped with; export re-signs it for
        // distribution.
        mode: 'development',
        appGroup: [appGroup],
        // The extension needs no background mode, and adding one to the app
        // would be one more capability to justify in review.
        backgroundModes: { remoteNotifications: false, fetch: false },
        nse: {
          bundleName: NSE_TARGET,
          sourceFiles: ['./ios-extensions/NotificationService.swift'],
          extraInfoPlist: { SeixoAppGroup: appGroup },
          extraBuildSettings: { IPHONEOS_DEPLOYMENT_TARGET: '15.1' },
        },
      },
    ],
  ],
  extra: {
    ...base.extra,
    // Read by the app (notifications/useAppBadge.ts) to write the badge count
    // where the extension can find it.
    appGroup,
    eas: {
      ...base.extra?.eas,
      build: {
        experimental: {
          ios: {
            // expo-share-intent registers its own extension here; the NSE plugin
            // does not, and without an entry EAS never creates the extension's
            // identifier or provisioning profile, and signing fails.
            appExtensions: [
              {
                targetName: NSE_TARGET,
                bundleIdentifier: `${bundleIdentifier}.${NSE_TARGET}`,
                entitlements: {
                  'com.apple.security.application-groups': [appGroup],
                },
              },
            ],
          },
        },
      },
    },
  },
});
