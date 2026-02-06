/**
 * Build a Sui transaction to add Take Profit and/or Stop Loss conditional orders.
 * Uses @mysten/deepbook-v3 marginTPSL.addConditionalOrder.
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/tpsl
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

const MANAGER_KEY = "MARGIN_MANAGER_1";

export type PrepareAddTpslParams = {
  sender: string;
  marginManagerId: string;
  poolKey: string;
  /** Long position = true, short = false. TP/SL direction is derived from this. */
  isLong: boolean;
  /** Quantity for the closing order when TP or SL triggers. */
  quantity: number;
  /** Take profit trigger price (optional). */
  tpPrice?: number;
  /** Stop loss trigger price (optional). */
  slPrice?: number;
  payWithDeep?: boolean;
  network?: "mainnet" | "testnet";
};

export type PrepareAddTpslResult = {
  intentMessageHashHex: string;
  txBytesBase64: string;
};

function nextId(): number {
  return Math.floor(Date.now() % 2147483647);
}

function uniqueIds(base: number): {
  tpCondId: number;
  slCondId: number;
  tpClientId: number;
  slClientId: number;
} {
  return {
    tpCondId: base,
    slCondId: base + 1,
    tpClientId: base + 2,
    slClientId: base + 3,
  };
}

export async function prepareAddTpsl(
  params: PrepareAddTpslParams
): Promise<PrepareAddTpslResult> {
  const {
    sender,
    marginManagerId,
    poolKey,
    isLong,
    quantity,
    tpPrice,
    slPrice,
    payWithDeep = true,
    network = "mainnet",
  } = params;

  if (!tpPrice && !slPrice) {
    throw new Error("At least one of tpPrice or slPrice is required");
  }
  if (!quantity || quantity <= 0) {
    throw new Error("Quantity must be positive");
  }

  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });
  const pools = network === "mainnet" ? mainnetPools : testnetPools;
  const coins = network === "mainnet" ? mainnetCoins : testnetCoins;

  if (!(poolKey in pools)) {
    throw new Error(`Unknown pool key: ${poolKey}`);
  }

  const extended = client.$extend(
    deepbook({
      address: sender,
      pools,
      coins,
      marginManagers: {
        [MANAGER_KEY]: { address: marginManagerId, poolKey },
      },
    })
  );

  const tx = new Transaction();
  tx.setSender(sender);

  const marginTPSL = extended.deepbook.marginTPSL;

  // Long: close by selling (isBid: false). TP = trigger when price rises (triggerBelowPrice: false). SL = trigger when price falls (triggerBelowPrice: true).
  // Short: close by buying (isBid: true). TP = trigger when price falls (triggerBelowPrice: true). SL = trigger when price rises (triggerBelowPrice: false).
  const closeIsBid = !isLong;
  const ids = uniqueIds(nextId());

  if (tpPrice != null && tpPrice > 0) {
    const triggerBelowPrice = isLong ? false : true; // TP for long: above; for short: below
    marginTPSL.addConditionalOrder({
      marginManagerKey: MANAGER_KEY,
      conditionalOrderId: String(ids.tpCondId),
      triggerBelowPrice,
      triggerPrice: tpPrice,
      pendingOrder: {
        clientOrderId: String(ids.tpClientId),
        quantity,
        isBid: closeIsBid,
        payWithDeep,
      },
    })(tx);
  }

  if (slPrice != null && slPrice > 0) {
    const triggerBelowPrice = isLong ? true : false; // SL for long: below; for short: above
    marginTPSL.addConditionalOrder({
      marginManagerKey: MANAGER_KEY,
      conditionalOrderId: String(ids.slCondId),
      triggerBelowPrice,
      triggerPrice: slPrice,
      pendingOrder: {
        clientOrderId: String(ids.slClientId),
        quantity,
        isBid: closeIsBid,
        payWithDeep,
      },
    })(tx);
  }

  const txBytes = await tx.build({ client });
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHashHex, txBytesBase64 };
}
