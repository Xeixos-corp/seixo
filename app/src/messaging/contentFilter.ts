/**
 * Hides received messages that contain offensive language until the person
 * chooses to see them.
 *
 * On the phone, because it cannot be anywhere else: the server never sees a
 * word of any message. App Review requires "a method for filtering
 * objectionable content" (Guideline 1.2); in an end-to-end encrypted app the
 * only honest one is this -- a filter that runs where the plaintext is, and
 * that nobody else learns anything from. Nothing is removed and nothing is
 * reported: the message is covered, and a tap uncovers it.
 *
 * Deliberately a short list of unambiguous words -- slurs, and the crudest
 * sexual and violent terms -- matched as whole words after folding accents
 * and case, so "Scunthorpe" and "classe" survive. A longer list catches more
 * and hides more ordinary conversation with it; the point is to take the
 * worst off the screen, not to police how adults talk.
 *
 * Only messages from others are filtered. Your own words are yours.
 */

const WORDS = [
  // Português
  'caralho', 'foda-se', 'fodase', 'foder', 'fodido', 'fodida', 'puta', 'putas', 'puto de merda',
  'cabrao', 'cabroes', 'paneleiro', 'paneleiros', 'maricas', 'rabeta', 'crica', 'cona', 'conas',
  'piroca', 'pila', 'broche', 'mamada', 'filho da puta', 'filha da puta', 'preto de merda',
  'macaco de merda', 'vou-te matar', 'vou te matar', 'mata-te', 'suicida-te', 'viado', 'buceta',
  // English
  'fuck', 'fucking', 'fucker', 'motherfucker', 'cunt', 'cunts', 'bitch', 'bitches', 'whore', 'slut',
  'faggot', 'fag', 'nigger', 'nigga', 'retard', 'dick', 'cock', 'pussy', 'kill yourself', 'kys',
  'i will kill you', "i'll kill you", 'rape', 'rapist',
  // Español
  'joder', 'jodido', 'coño', 'cono', 'puta madre', 'hijo de puta', 'hija de puta', 'cabron',
  'cabrones', 'maricon', 'maricones', 'polla', 'verga', 'chupapollas', 'zorra', 'mamon',
  'te voy a matar', 'matate', 'violar', 'violacion', 'sudaca', 'panchito',
];

/** Lowercase, accents removed, apostrophes kept, everything else a space. */
function fold(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9'ñ-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

const FOLDED = Array.from(new Set(WORDS.map((word) => fold(word))));

/** Whether a received message should be covered until tapped. */
export function isObjectionable(text: string | undefined | null): boolean {
  if (!text) return false;
  const folded = fold(text);
  return FOLDED.some((word) => folded.includes(word));
}
