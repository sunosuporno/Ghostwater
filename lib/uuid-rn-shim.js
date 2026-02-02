/**
 * Minimal uuid v4 shim for React Native. Root uuid's dist/rng.js uses Node's
 * require("crypto") which doesn't exist in RN, so the RNG returns undefined.
 * This shim uses crypto.getRandomValues (polyfilled by react-native-get-random-values).
 */

function bytesToUuid(buf, offset) {
  offset = offset || 0;
  const byteToHex = [];
  for (let i = 0; i < 256; i++) {
    byteToHex[i] = (i + 0x100).toString(16).substring(1);
  }
  return (
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    "-" +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    "-" +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    "-" +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    "-" +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]] +
    byteToHex[buf[offset++]]
  );
}

function v4() {
  const bytes = new Uint8Array(16);
  const crypto =
    typeof globalThis !== "undefined"
      ? globalThis.crypto
      : typeof global !== "undefined"
      ? global.crypto
      : undefined;
  if (!crypto || !crypto.getRandomValues) {
    throw new Error("crypto.getRandomValues not available");
  }
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

module.exports = v4;
module.exports.v4 = v4;
module.exports.default = v4;
