/**
 * Execute a signed "create margin manager" transaction and return the new manager ID.
 * Reuses the same signing/execute flow as transfer; parses result for created MarginManager.
 */

import type { SuiClientTypes } from "@mysten/sui/client";
import { toSerializedSignature } from "@mysten/sui/cryptography";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { publicKeyFromRawBytes } from "@mysten/sui/verify";
import { Buffer } from "buffer";

export type ExecuteCreateMarginManagerParams = {
  txBytesBase64: string;
  signatureHex: string;
  publicKeyHex: string;
  network?: "mainnet" | "testnet";
};

export type ExecuteCreateMarginManagerResult = {
  digest: string;
  margin_manager_id: string;
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

export async function executeCreateMarginManager(
  params: ExecuteCreateMarginManagerParams
): Promise<ExecuteCreateMarginManagerResult> {
  const {
    txBytesBase64,
    signatureHex,
    publicKeyHex,
    network = "mainnet",
  } = params;

  const txBytes = Buffer.from(txBytesBase64, "base64");
  const sigBytes = hexToBytes(signatureHex);
  let publicKeyRaw = hexToBytes(publicKeyHex);
  if (publicKeyRaw.length === 33 && publicKeyRaw[0] === 0x00) {
    publicKeyRaw = publicKeyRaw.slice(1);
  }
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
    include: { effects: true, objectTypes: true },
  });

  if (result.$kind === "FailedTransaction") {
    const status = result.FailedTransaction.effects?.status;
    const err =
      status && typeof status === "object" && "error" in status
        ? String(
            (status as { error?: { message?: string } }).error?.message ??
              "Transaction failed"
          )
        : "Transaction failed";
    throw new Error(err);
  }

  const tx = result.Transaction as SuiClientTypes.Transaction<{
    effects: true;
    objectTypes: true;
  }>;
  const effects = tx.effects;
  const objectTypes = tx.objectTypes ?? {};
  const changedObjects = effects?.changedObjects ?? [];

  const created = changedObjects.find(
    (obj) =>
      obj.idOperation === "Created" &&
      objectTypes[obj.objectId]?.includes("MarginManager")
  );

  if (!created?.objectId) {
    throw new Error(
      "Could not find created MarginManager in transaction result"
    );
  }

  return {
    digest: tx.digest,
    margin_manager_id: created.objectId,
  };
}
