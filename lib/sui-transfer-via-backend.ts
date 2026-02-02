/**
 * Sui transfer via backend: prepare (backend) -> sign (Privy in app) -> execute (backend).
 * No @mysten/sui in the app — safe for React Native.
 */

const DEFAULT_NETWORK = "mainnet";

export type SendViaBackendParams = {
  apiUrl: string;
  sender: string;
  recipient: string;
  coinType: string;
  amountMist: string;
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    bytes: string;
    encoding: "hex";
    hash_function: "blake2b256";
  }) => Promise<{ signature: string }>;
  publicKeyHex: string; // 0x + 64 hex chars (32 bytes)
  network?: "mainnet" | "testnet";
};

export type SendViaBackendResult = {
  digest: string;
};

/**
 * 1. POST /api/prepare-transfer -> intentMessageHex, txBytesBase64
 * 2. Sign intentMessageHex with signRawHash (Privy)
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

  const prepareRes = await fetch(`${base}/api/prepare-transfer`, {
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
  const prepareJson = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error(prepareJson.error ?? "Prepare failed");
  }
  const { intentMessageHex, txBytesBase64 } = prepareJson;

  const { signature: signatureHex } = await signRawHash({
    address: sender,
    chainType: "sui",
    bytes: intentMessageHex,
    encoding: "hex",
    hash_function: "blake2b256",
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

/** Convert app's publicKey (string hex or Uint8Array) to hex string for backend. */
export function publicKeyToHex(publicKey: string | Uint8Array): string {
  if (typeof publicKey === "string") {
    const s = publicKey.trim();
    return s.startsWith("0x") ? s : "0x" + s;
  }
  if (publicKey.length !== 32) {
    throw new Error("Invalid public key: expected 32 bytes");
  }
  let hex = "";
  for (let i = 0; i < publicKey.length; i++) {
    hex += publicKey[i].toString(16).padStart(2, "0");
  }
  return "0x" + hex;
}
