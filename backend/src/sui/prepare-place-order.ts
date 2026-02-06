/**
 * Build a Sui transaction to place a margin limit or market order.
 * Optionally borrows first (borrowBase/borrowQuote) so the margin account has
 * enough balance for the order; then places the order via poolProxy.
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/orders
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/margin-manager#borrowbase-borrowquote
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

export type PreparePlaceOrderParams = {
  sender: string;
  marginManagerId: string;
  poolKey: string;
  orderType: "limit" | "market";
  isBid: boolean;
  quantity: number;
  price?: number; // required for limit
  clientOrderId: number; // u64 for SDK
  payWithDeep?: boolean;
  network?: "mainnet" | "testnet";
  /** If true, use placeReduceOnlyMarketOrder (for closing positions). */
  reduceOnly?: boolean;
  /** Borrow base (e.g. SUI) before placing order; used for short. Human units. */
  borrowBaseAmount?: number;
  /** Borrow quote (e.g. USDC) before placing order; used for long. Human units. */
  borrowQuoteAmount?: number;
};

export type PreparePlaceOrderResult = {
  intentMessageHashHex: string;
  txBytesBase64: string;
};

export async function preparePlaceOrder(
  params: PreparePlaceOrderParams
): Promise<PreparePlaceOrderResult> {
  const {
    sender,
    marginManagerId,
    poolKey,
    orderType,
    isBid,
    quantity,
    price,
    clientOrderId,
    payWithDeep = true,
    network = "mainnet",
    reduceOnly = false,
    borrowBaseAmount,
    borrowQuoteAmount,
  } = params;

  if (orderType === "limit" && (price == null || Number.isNaN(price))) {
    throw new Error("Price is required for limit orders");
  }
  if (!quantity || quantity <= 0) {
    throw new Error("Quantity must be positive");
  }

  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });

  const pools = network === "mainnet" ? mainnetPools : testnetPools;
  const coins = network === "mainnet" ? mainnetCoins : testnetCoins;

  if (!(poolKey in pools)) {
    throw new Error(
      `Unknown pool key: ${poolKey}. Valid keys include: ${Object.keys(pools)
        .slice(0, 10)
        .join(", ")}`
    );
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

  const { marginManager, poolProxy } = extended.deepbook;

  if (borrowBaseAmount != null && borrowBaseAmount > 0) {
    marginManager.borrowBase(MANAGER_KEY, borrowBaseAmount)(tx);
  }
  if (borrowQuoteAmount != null && borrowQuoteAmount > 0) {
    marginManager.borrowQuote(MANAGER_KEY, borrowQuoteAmount)(tx);
  }

  const clientOrderIdStr = String(clientOrderId);
  if (orderType === "limit") {
    poolProxy.placeLimitOrder({
      poolKey,
      marginManagerKey: MANAGER_KEY,
      clientOrderId: clientOrderIdStr,
      price: price!,
      quantity,
      isBid,
      payWithDeep,
    })(tx);
  } else if (reduceOnly) {
    poolProxy.placeReduceOnlyMarketOrder({
      poolKey,
      marginManagerKey: MANAGER_KEY,
      clientOrderId: clientOrderIdStr,
      quantity,
      isBid,
      payWithDeep,
    })(tx);
  } else {
    poolProxy.placeMarketOrder({
      poolKey,
      marginManagerKey: MANAGER_KEY,
      clientOrderId: clientOrderIdStr,
      quantity,
      isBid,
      payWithDeep,
    })(tx);
  }

  const txBytes = await tx.build({ client });
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHashHex, txBytesBase64 };
}
