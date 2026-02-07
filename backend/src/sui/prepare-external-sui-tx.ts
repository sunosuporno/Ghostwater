/**
 * Compute intent message hash for arbitrary Sui tx bytes (e.g. from LiFi quote).
 * Used when the app has tx bytes from an external source and needs to sign them via Privy.
 * Execute the signed tx via existing POST /api/execute-transfer.
 */

import { messageWithIntent } from "@mysten/sui/cryptography";
import { blake2b } from "@noble/hashes/blake2.js";
import { Buffer } from "buffer";

export type PrepareExternalSuiTxParams = {
  txBytesBase64: string;
};

export type PrepareExternalSuiTxResult = {
  /** Blake2b256 hash of intent message (0x-prefixed hex). Pass to signRawHash({ hash }). */
  intentMessageHashHex: string;
};

export async function prepareExternalSuiTx(
  params: PrepareExternalSuiTxParams
): Promise<PrepareExternalSuiTxResult> {
  const { txBytesBase64 } = params;
  if (!txBytesBase64 || typeof txBytesBase64 !== "string") {
    throw new Error("txBytesBase64 is required");
  }
  let txBytes: Buffer;
  try {
    txBytes = Buffer.from(txBytesBase64, "base64");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid base64 txBytes: ${msg}`);
  }
  if (txBytes.length === 0) {
    throw new Error("txBytesBase64 decoded to empty buffer");
  }
  let intentMessage: Uint8Array;
  try {
    intentMessage = messageWithIntent("TransactionData", new Uint8Array(txBytes));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`messageWithIntent failed: ${msg}`);
  }
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  return { intentMessageHashHex };
}
