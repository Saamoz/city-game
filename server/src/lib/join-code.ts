import { randomInt } from 'node:crypto';

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH = 8;

export function generateJoinCode(length = JOIN_CODE_LENGTH): string {
  let value = '';

  for (let index = 0; index < length; index += 1) {
    value += JOIN_CODE_ALPHABET[randomInt(0, JOIN_CODE_ALPHABET.length)];
  }

  return value;
}
