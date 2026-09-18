/**
 * Reading what a JPEG says about itself, before it is allowed to leave.
 *
 * Kept apart from attachments.ts on purpose: it touches no files and no
 * native modules, so it can be tested on its own against real photos with
 * and without location data (app/scripts/test-jpeg-metadata.js). The first
 * version of this check refused every photo, because iOS writes a small,
 * harmless EXIF block into every JPEG it encodes -- a mistake a test would
 * have caught before anyone's phone did.
 */

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif" followed by two zero bytes
const XMP_ID = [0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x6e, 0x73, 0x2e, 0x61, 0x64, 0x6f, 0x62, 0x65]; // "http://ns.adobe"

/** Image structure only: how to lay the pixels out, nothing about the scene. */
const IFD0_ALLOWED = new Set([
  0x0100, // ImageWidth
  0x0101, // ImageLength
  0x0102, // BitsPerSample
  0x0103, // Compression
  0x0106, // PhotometricInterpretation
  0x0112, // Orientation
  0x0115, // SamplesPerPixel
  0x011a, // XResolution
  0x011b, // YResolution
  0x011c, // PlanarConfiguration
  0x0128, // ResolutionUnit
  0x0212, // YCbCrSubSampling
  0x0213, // YCbCrPositioning
]);
/** The same, plus where an embedded thumbnail of this same picture sits. */
const IFD1_ALLOWED = new Set([...IFD0_ALLOWED, 0x0201, 0x0202]);
const EXIF_ALLOWED = new Set([
  0x9000, // ExifVersion
  0x9101, // ComponentsConfiguration
  0xa000, // FlashpixVersion
  0xa001, // ColorSpace
  0xa002, // PixelXDimension
  0xa003, // PixelYDimension
]);
const GPS_POINTER = 0x8825;
const EXIF_POINTER = 0x8769;
const INTEROP_POINTER = 0xa005;

/** Every reason to refuse the picture; empty means clean. */
export function inspectJpegMetadata(bytes: Uint8Array): string[] {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return ['not a JPEG'];

  const findings: string[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    // Markers that carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // Start of scan or end of image: the header is over, pixels follow.
    if (marker === 0xda || marker === 0xd9) break;

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const start = offset + 4;
    const end = offset + 2 + length;

    if (marker === 0xe1) {
      if (startsWith(bytes, start, EXIF_ID)) {
        findings.push(...inspectExif(bytes, start + EXIF_ID.length, Math.min(end, bytes.length)));
      } else if (startsWith(bytes, start, XMP_ID)) {
        findings.push('XMP');
      } else {
        findings.push('unrecognised APP1');
      }
    } else if (marker === 0xed) {
      findings.push('IPTC');
    }

    if (end <= offset) break;
    offset = end;
  }
  return findings;
}

function inspectExif(bytes: Uint8Array, tiff: number, limit: number): string[] {
  if (tiff + 8 > limit) return ['EXIF truncated'];
  const little = bytes[tiff] === 0x49;
  const u16 = (at: number) =>
    little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1];
  const u32 = (at: number) =>
    (little
      ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
      : (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

  if (u16(tiff + 2) !== 42) return ['EXIF malformed'];

  const findings: string[] = [];
  const visit = (ifdOffset: number, allowed: Set<number>, label: string, depth: number) => {
    const at = tiff + ifdOffset;
    if (depth > 3 || at + 2 > limit) {
      findings.push(`${label} unreadable`);
      return;
    }
    const count = u16(at);
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > limit) {
        findings.push(`${label} truncated`);
        return;
      }
      const tag = u16(entry);
      if (tag === GPS_POINTER) findings.push('GPS');
      else if (tag === EXIF_POINTER) visit(u32(entry + 8), EXIF_ALLOWED, 'Exif', depth + 1);
      // Format bookkeeping between readers ("R98"), nothing about the picture.
      else if (tag === INTEROP_POINTER) continue;
      else if (!allowed.has(tag)) findings.push(`${label} 0x${tag.toString(16).padStart(4, '0')}`);
    }
    if (label === 'IFD0') {
      const nextAt = at + 2 + count * 12;
      if (nextAt + 4 <= limit) {
        const next = u32(nextAt);
        if (next) visit(next, IFD1_ALLOWED, 'IFD1', depth + 1);
      }
    }
  };

  visit(u32(tiff + 4), IFD0_ALLOWED, 'IFD0', 0);
  return findings;
}

function startsWith(bytes: Uint8Array, at: number, prefix: number[]): boolean {
  if (at + prefix.length > bytes.length) return false;
  return prefix.every((byte, i) => bytes[at + i] === byte);
}

/** Small and dependency-free: used only on a file's first bytes. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Small and dependency-free: used only on the first 64 KB of a file. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    buffer = ((buffer << 6) | BASE64_ALPHABET.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, index);
}
