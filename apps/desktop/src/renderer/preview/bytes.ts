/**
 * `atob` yields a binary string whose code units are bytes; `charCodeAt` copies them
 * back into a `Uint8Array`, which is the shape pdf.js parses.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
