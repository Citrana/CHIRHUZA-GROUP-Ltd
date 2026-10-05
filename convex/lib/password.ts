const LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l/o (visual ambiguity)
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O
const DIGITS = "23456789"; // no 0/1
const SYMBOLS = "!@#$%^&*-_=+";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;
const LENGTH = 16;

function randomChar(charset: string): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return charset[bytes[0] % charset.length];
}

function shuffle(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i--) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const j = bytes[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

/**
 * Generates a 16-character password with at least one lowercase, uppercase,
 * digit, and symbol character, drawn from a cryptographically secure random
 * source. Used only for admin-created accounts (see createUser in
 * convex/users.ts) - the caller must show it to the admin exactly once.
 */
export function generateStrongPassword(): string {
  const required = [
    randomChar(LOWER),
    randomChar(UPPER),
    randomChar(DIGITS),
    randomChar(SYMBOLS),
  ];
  const rest = Array.from({ length: LENGTH - required.length }, () =>
    randomChar(ALL),
  );
  return shuffle([...required, ...rest]).join("");
}
