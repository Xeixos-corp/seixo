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

module.exports = () => ({
  ...base,
  name: IS_DEV ? 'Seixo Dev' : base.name,
  ios: {
    ...base.ios,
    bundleIdentifier: IS_DEV ? `${base.ios.bundleIdentifier}.dev` : base.ios.bundleIdentifier,
  },
  android: {
    ...base.android,
    package: IS_DEV ? `${base.android.package}.dev` : base.android.package,
  },
});
