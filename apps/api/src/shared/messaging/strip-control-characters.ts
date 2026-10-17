// C0, DEL and C1: what lets a stored string move an operator's cursor or start an escape sequence.
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '');
}
