/**
 * Build a Sui transfer transaction and return intent message hash (for client to sign)
 * and raw tx bytes (for execute step). Uses @mysten/sui (runs only on backend).
 * Expo useSignRawHash only accepts `hash`, so we compute blake2b256(intentMessage) here.
 */

import { messageWithIntent } from "@mysten/sui/cryptography";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2.js";
import { Buffer } from "buffer";

const SUI_COIN_TYPE = "0x2::sui::SUI";

export type PrepareTransferParams = {
  sender: string;
  recipient: string;
  coinType: string;
  amountMist: string; // decimal string for JSON
  network?: "mainnet" | "testnet";
};

export type PrepareTransferResult = {
  /** Blake2b256 hash of intent message (0x-prefixed hex). Pass to signRawHash({ hash }). */
  intentMessageHashHex: string;
  txBytesBase64: string;
};

export async function prepareTransfer(
  params: PrepareTransferParams
): Promise<PrepareTransferResult> {
  const {
    sender,
    recipient,
    coinType,
    amountMist: amountStr,
    network = "mainnet",
  } = params;

  if (amountStr == null || amountStr === "") {
    throw new Error("Amount is required (amountMist)");
  }
  const amountMist = BigInt(amountStr);

  if (amountMist <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });

  const tx = new Transaction();
  tx.setSender(sender);

  // Balance is validated in the app. We just build the tx; if insufficient, execution will fail on-chain.
  const isSui = coinType === SUI_COIN_TYPE;
  if (isSui) {
    const [coin] = tx.splitCoins(tx.gas, [amountMist]);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    const { objects: coins } = await client.core.listCoins({
      owner: sender,
      coinType,
    });
    if (!coins?.length) throw new Error("No coins to transfer");
    const totalAvailable = coins.reduce<bigint>(
      (sum, c) => sum + BigInt(c.balance ?? 0),
      0n
    );
    if (amountMist > totalAvailable) throw new Error("Amount exceeds balance");
    const coinRefs = coins.map((c) => c.objectId);
    if (coinRefs.length === 1) {
      const [coin] = tx.splitCoins(tx.object(coinRefs[0]), [amountMist]);
      tx.transferObjects([coin], tx.pure.address(recipient));
    } else {
      const [primary, ...rest] = coinRefs;
      const primaryObj = tx.object(primary);
      tx.mergeCoins(
        primaryObj,
        rest.map((id) => tx.object(id))
      );
      const [coin] = tx.splitCoins(primaryObj, [amountMist]);
      tx.transferObjects([coin], tx.pure.address(recipient));
    }
  }

  const txBytes = await tx.build({ client });
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHashHex, txBytesBase64 };
}
