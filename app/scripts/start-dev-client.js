// Starts Metro for the "Seixo Dev" development build.
//
// APP_VARIANT must be "development" here, not only in eas.json. The build's
// native side already carries the Dev identifiers, but the JavaScript it loads
// from this server reads its config -- the URL scheme and, above all, the App
// Group in extra.appGroup -- from app.config.js as evaluated by this process.
// Started without the variant, Seixo Dev would write its badge count into the
// released app's App Group, which it cannot even access, and the share
// extension's hand-off would look under the wrong scheme.
//
// A script rather than `APP_VARIANT=development expo start` because that
// syntax does not work in the Windows shells this project is run from.

const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn('npx', ['expo', 'start', '--dev-client'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, APP_VARIANT: 'development' },
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => process.exit(code ?? 0));
