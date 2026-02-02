/**
 * Take signed intent (signature + public key) and tx bytes, build serialized
 * signature, then execute on Sui. Uses @mysten/sui (runs only on backend).
 */

import { toSerializedSignature } from "@mysten/sui/cryptography";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { publicKeyFromRawBytes } from "@mysten/sui/verify";

export type ExecuteTransferParams = {
  txBytesBase64: string;
  signatureHex: string;
  publicKeyHex: string; // 0x + 64 hex chars (32 bytes)
  network?: "mainnet" | "testnet";
};

export type ExecuteTransferResult = {
  digest: string;
};

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const len = h.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function executeTransfer(
  params: ExecuteTransferParams
): Promise<ExecuteTransferResult> {
  const {
    txBytesBase64,
    signatureHex,
    publicKeyHex,
    network = "mainnet",
  } = params;

  const txBytes = new Uint8Array(Buffer.from(txBytesBase64, "base64"));
  const sigBytes = hexToBytes(signatureHex);
  const publicKeyRaw = hexToBytes(publicKeyHex);
  if (publicKeyRaw.length !== 32) {
    throw new Error("Invalid public key: expected 32 bytes (64 hex chars)");
  }

  const publicKey = publicKeyFromRawBytes("ED25519", publicKeyRaw);
  const serializedSig = toSerializedSignature({
    signature: sigBytes,
    signatureScheme: "ED25519",
    publicKey,
  });

  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });

  const result = await client.core.executeTransaction({
    transaction: txBytes,
    signatures: [serializedSig],
    include: { effects: true },
  });

  if (result.$kind === "FailedTransaction") {
    const err =
      result.FailedTransaction.effects?.status &&
      "error" in result.FailedTransaction.effects.status
        ? (result.FailedTransaction.effects.status as { error?: string }).error
        : "Transaction failed";
    throw new Error(err ?? "Transaction failed");
  }

  return { digest: result.Transaction.digest };
}
