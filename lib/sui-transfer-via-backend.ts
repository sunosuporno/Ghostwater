/**
 * Sui transfer via backend: prepare (backend) -> sign (Privy in app) -> execute (backend).
 * No @mysten/sui in the app — safe for React Native.
 * Expo useSignRawHash only accepts { address, chainType, hash } (no bytes/params).
 */

const DEFAULT_NETWORK = "mainnet";

export type SendViaBackendParams = {
  apiUrl: string;
  sender: string;
  recipient: string;
  coinType: string;
  amountMist: string;
  /** Expo useSignRawHash: (input: { address, chainType, hash: `0x${string}` }) => Promise<{ signature }> */
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    hash: `0x${string}`;
  }) => Promise<{ signature: string }>;
  publicKeyHex: string; // 0x + 64 hex chars (32 bytes)
  network?: "mainnet" | "testnet";
};

export type SendViaBackendResult = {
  digest: string;
};

/**
 * 1. POST /api/prepare-transfer -> intentMessageHashHex, txBytesBase64
 * 2. Sign intentMessageHashHex with signRawHash (Privy; Expo only accepts hash)
 * 3. POST /api/execute-transfer -> digest
 */
export async function sendViaBackend(
  params: SendViaBackendParams
): Promise<SendViaBackendResult> {
  const {
    apiUrl,
    sender,
    recipient,
    coinType,
    amountMist,
    signRawHash,
    publicKeyHex,
    network = DEFAULT_NETWORK,
  } = params;

  const base = apiUrl.replace(/\/$/, "");

  let prepareRes: Response;
  let prepareJson: Record<string, unknown>;
  try {
    prepareRes = await fetch(`${base}/api/prepare-transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender,
        recipient,
        coinType,
        amountMist,
        network,
      }),
    });
    prepareJson = await prepareRes.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Request failed";
    throw new Error(
      `Cannot reach backend (${base}). ${msg}. On a device, set EXPO_PUBLIC_API_URL to your machine IP (e.g. http://192.168.1.x:3001).`
    );
  }
  if (!prepareRes.ok) {
    throw new Error((prepareJson.error as string) ?? "Prepare failed");
  }
  // Backend may return camelCase or snake_case
  const intentMessageHashHex =
    prepareJson.intentMessageHashHex ?? prepareJson.intent_message_hash_hex;
  const txBytesBase64 =
    prepareJson.txBytesBase64 ?? prepareJson.tx_bytes_base64;

  if (
    typeof intentMessageHashHex !== "string" ||
    !intentMessageHashHex ||
    typeof txBytesBase64 !== "string" ||
    !txBytesBase64
  ) {
    throw new Error(
      "Invalid prepare response: missing intentMessageHashHex or txBytesBase64"
    );
  }

  // Expo useSignRawHash only accepts { address, chainType, hash } (sends params.hash to API).
  const { signature: signatureHex } = await signRawHash({
    address: sender,
    chainType: "sui",
    hash: intentMessageHashHex.startsWith("0x")
      ? (intentMessageHashHex as `0x${string}`)
      : (`0x${intentMessageHashHex}` as `0x${string}`),
  });

  const executeRes = await fetch(`${base}/api/execute-transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      txBytesBase64,
      signatureHex,
      publicKeyHex: publicKeyHex.startsWith("0x")
        ? publicKeyHex
        : "0x" + publicKeyHex,
      network,
    }),
  });
  const executeJson = await executeRes.json();
  if (!executeRes.ok) {
    throw new Error(executeJson.error ?? "Execute failed");
  }
  return { digest: executeJson.digest };
}

/**
 * Normalize to raw 32-byte ED25519 public key hex for the backend.
 * Accepts: 64 hex chars (32 bytes), 66 hex (33 bytes with 0x00 scheme), or Uint8Array 32/33 bytes.
 */
function toRaw32Hex(bytes: Uint8Array): string {
  let raw = bytes;
  if (bytes.length === 33 && bytes[0] === 0x00) {
    raw = bytes.slice(1);
  }
  if (raw.length !== 32) {
    throw new Error("Invalid public key: expected 32 bytes (64 hex chars)");
  }
  let hex = "";
  for (let i = 0; i < raw.length; i++) {
    hex += raw[i].toString(16).padStart(2, "0");
  }
  return "0x" + hex;
}

/** Convert app's publicKey (string hex or Uint8Array) to 32-byte hex for backend. */
export function publicKeyToHex(publicKey: string | Uint8Array): string {
  if (typeof publicKey === "string") {
    const s = publicKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(s)) {
      throw new Error("Invalid public key: expected hex (64 or 66 chars)");
    }
    const len = s.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    return toRaw32Hex(bytes);
  }
  return toRaw32Hex(publicKey);
}
