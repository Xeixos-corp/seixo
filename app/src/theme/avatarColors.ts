/**
 * A colour per contact, the same one every time, so a conversation can be
 * recognised at a glance before its name is read.
 *
 * Derived from the contact's id on the phone, never chosen or stored: there is
 * nothing to sync, nothing to send, and the same person gets the same colour
 * on every device that knows them. Two people can share a colour -- there are
 * only seven -- which is fine; the colour helps tell rows apart, the name is
 * what identifies someone.
 *
 * Pairs are picked for contrast in each theme: a pale fill with dark text in
 * light mode, a deep fill with light text in dark mode.
 */

type AvatarColor = { background: string; foreground: string };

const LIGHT: AvatarColor[] = [
  { background: '#EEEDFE', foreground: '#3C3489' },
  { background: '#E1F5EE', foreground: '#085041' },
  { background: '#FAECE7', foreground: '#712B13' },
  { background: '#FBEAF0', foreground: '#72243E' },
  { background: '#E6F1FB', foreground: '#0C447C' },
  { background: '#EAF3DE', foreground: '#27500A' },
  { background: '#FAEEDA', foreground: '#633806' },
];

const DARK: AvatarColor[] = [
  { background: '#3C3489', foreground: '#CECBF6' },
  { background: '#085041', foreground: '#9FE1CB' },
  { background: '#712B13', foreground: '#F5C4B3' },
  { background: '#72243E', foreground: '#F4C0D1' },
  { background: '#0C447C', foreground: '#B5D4F4' },
  { background: '#27500A', foreground: '#C0DD97' },
  { background: '#633806', foreground: '#FAC775' },
];

/** FNV-1a: small, fast, and spreads similar ids across different colours. */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

export function avatarColorFor(seed: string, dark: boolean): AvatarColor {
  const palette = dark ? DARK : LIGHT;
  return palette[hash(seed) % palette.length];
}

/**
 * What goes inside the circle.
 *
 * The first letter of the name the person was given. A contact with no name
 * yet is shown by the start of their id, so two characters rather than one:
 * a single hex digit would make most unnamed contacts look alike.
 */
export function initialsFor(displayName: string, hasName: boolean): string {
  const trimmed = displayName.trim();
  if (!trimmed) return '?';
  if (!hasName) return trimmed.slice(0, 2).toUpperCase();
  // Array.from keeps a letter with an accent, or an emoji, in one piece.
  return (Array.from(trimmed)[0] ?? '?').toUpperCase();
}
