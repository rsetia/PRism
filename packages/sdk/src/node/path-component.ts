import { Buffer } from "node:buffer";

const COMPONENT_PREFIX = "v1-";
const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
// Common filesystems cap one path component at 255 bytes. Leave room for
// adapter-owned suffixes and fail explicitly instead of truncating into an
// alias of another identifier.
const MAX_COMPONENT_BYTES = 240;

/**
 * Encode an arbitrary identifier as one reversible filesystem component.
 * Lowercase base32 contains no path separators and remains distinct on
 * case-insensitive filesystems. The version prefix leaves room to change the
 * on-disk representation deliberately in a future schema.
 */
export function encodePathComponent(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (!isWellFormedUnicode(value)) {
    throw new Error(`${label} must contain well-formed Unicode`);
  }
  const component = `${COMPONENT_PREFIX}${encodeBase32(Buffer.from(value, "utf8"))}`;
  if (Buffer.byteLength(component, "utf8") > MAX_COMPONENT_BYTES) {
    throw new Error(
      `${label} is too long to encode as a filesystem path component`,
    );
  }
  return component;
}

/** Decode a component written by encodePathComponent, rejecting corruption. */
export function decodePathComponent(component: string, label: string): string {
  if (!component.startsWith(COMPONENT_PREFIX)) {
    throw new Error(`${label} has an unsupported path encoding`);
  }
  const encoded = component.slice(COMPONENT_PREFIX.length);
  const value = Buffer.from(decodeBase32(encoded, label)).toString("utf8");
  if (encodePathComponent(value, label) !== component) {
    throw new Error(`${label} has an invalid path encoding`);
  }
  return value;
}

function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let pending = 0;
  let pendingBits = 0;
  for (const byte of bytes) {
    pending = (pending << 8) | byte;
    pendingBits += 8;
    while (pendingBits >= 5) {
      pendingBits -= 5;
      output += BASE32_ALPHABET[(pending >>> pendingBits) & 31];
      pending &= (1 << pendingBits) - 1;
    }
  }
  if (pendingBits > 0) {
    output += BASE32_ALPHABET[(pending << (5 - pendingBits)) & 31];
  }
  return output;
}

function decodeBase32(encoded: string, label: string): Uint8Array {
  let pending = 0;
  let pendingBits = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) {
      throw new Error(`${label} has an invalid path encoding`);
    }
    pending = (pending << 5) | digit;
    pendingBits += 5;
    if (pendingBits >= 8) {
      pendingBits -= 8;
      bytes.push((pending >>> pendingBits) & 255);
      pending &= (1 << pendingBits) - 1;
    }
  }
  if (pending !== 0) {
    throw new Error(`${label} has an invalid path encoding`);
  }
  return Uint8Array.from(bytes);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
