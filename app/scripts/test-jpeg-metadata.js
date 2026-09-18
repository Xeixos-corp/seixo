// Runs the pre-send metadata check against real JPEGs, with and without the
// things it exists to catch.
//
//   node scripts/test-jpeg-metadata.js
//
// The check lives in src/messaging/jpegMetadata.ts, which touches no files and
// no native modules precisely so that it can be tested here. Its first
// version refused every photo -- iOS writes a small, harmless EXIF block into
// every JPEG it encodes -- and that was found on a phone, not by a test. This
// is the test.
//
// The fixtures are tiny and were made on purpose: the "ios_like" pair carries
// the structural tags iOS writes, in both byte orders (iOS uses big-endian);
// the rest each carry one thing that must never leave the phone.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'messaging', 'jpegMetadata.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const mod = { exports: {} };
new Function('module', 'exports', outputText)(mod, mod.exports);
const { inspectJpegMetadata, base64ToBytes } = mod.exports;

const FIXTURES = path.join(__dirname, 'fixtures', 'jpeg-metadata');

// What each file must produce. An empty list means "clean, may be sent".
const EXPECTED = {
  'clean_jfif.jpg': [],
  'ios_like.jpg': [],
  'ios_like_mm.jpg': [],
  'gps_only.jpg': ['GPS'],
  'gps_mm.jpg': ['GPS'],
  'model_only.jpg': ['IFD0 0x0110'],
  'date_only.jpg': ['Exif 0x9003'],
  'serial_mm.jpg': ['Exif 0xa431'],
  'xmp.jpg': ['XMP'],
  'camera_with_gps.jpg': ['IFD0 0x010f', 'IFD0 0x0110', 'Exif 0x9003', 'GPS'],
  // IPTC, in the Photoshop block iOS writes. Version and character set are
  // about the record, not the picture, and must pass -- refusing them refused
  // every photo on a real phone.
  'iptc_version_only.jpg': [],
  'iptc_padded.jpg': [],
  'iptc_city.jpg': ['IPTC 2:90'],
  'iptc_caption.jpg': ['IPTC 2:120'],
  'app13_thumbnail.jpg': ['APP13 0x040c'],
  'iptc_extended.jpg': ['IPTC 2:120 extended'],
};

let failed = 0;
for (const [file, expected] of Object.entries(EXPECTED)) {
  // Through base64 and back, exactly as the app reads the file.
  const base64 = fs.readFileSync(path.join(FIXTURES, file)).toString('base64');
  const findings = inspectJpegMetadata(base64ToBytes(base64));

  const same =
    findings.length === expected.length && expected.every((item) => findings.includes(item));
  const verdict = findings.length === 0 ? 'sent' : 'refused';
  console.log(`${same ? 'ok  ' : 'FAIL'}  ${file.padEnd(22)} ${verdict.padEnd(8)} ${JSON.stringify(findings)}`);
  if (!same) {
    console.log(`      expected ${JSON.stringify(expected)}`);
    failed++;
  }
}

// A truncated header must be refused, never waved through.
const truncated = base64ToBytes(fs.readFileSync(path.join(FIXTURES, 'camera_with_gps.jpg')).toString('base64')).subarray(0, 40);
const truncatedFindings = inspectJpegMetadata(truncated);
const truncatedOk = truncatedFindings.length > 0;
console.log(`${truncatedOk ? 'ok  ' : 'FAIL'}  ${'(truncated header)'.padEnd(22)} ${truncatedOk ? 'refused' : 'sent   '} ${JSON.stringify(truncatedFindings)}`);
if (!truncatedOk) failed++;

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
