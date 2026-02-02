/**
 * Build a Sui transaction to create (and share) a new margin manager for a pool.
 * Returns intent message hash and tx bytes for the client to sign.
 */

import {
  deepbook,
  mainnetCoins,
  mainnetPools,
  testnetCoins,
  testnetPools,
} from "@mysten/deepbook-v3";
import { messageWithIntent } from "@mysten/sui/cryptography";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2.js";
import { Buffer } from "buffer";

export type PrepareCreateMarginManagerParams = {
  sender: string;
  poolKey: string; // e.g. "SUI_USDC", "SUI_DBUSDC"
  network?: "mainnet" | "testnet";
};

export type PrepareCreateMarginManagerResult = {
  intentMessageHashHex: string;
  txBytesBase64: string;
};

export async function prepareCreateMarginManager(
  params: PrepareCreateMarginManagerParams
): Promise<PrepareCreateMarginManagerResult> {
  const { sender, poolKey, network = "mainnet" } = params;

  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });

  const pools = network === "mainnet" ? mainnetPools : testnetPools;
  const coins = network === "mainnet" ? mainnetCoins : testnetCoins;

  if (!(poolKey in pools)) {
    throw new Error(
      `Unknown pool key: ${poolKey}. Valid keys: ${Object.keys(pools).join(
        ", "
      )}`
    );
  }

  const extended = client.$extend(
    deepbook({
      address: sender,
      pools,
      coins,
    })
  );

  const tx = new Transaction();
  tx.setSender(sender);
  extended.deepbook.marginManager.newMarginManager(poolKey)(tx);

  const txBytes = await tx.build({ client });
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHashHex, txBytesBase64 };
}
