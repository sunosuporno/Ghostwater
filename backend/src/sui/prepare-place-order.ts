/**
 * Build a Sui transaction to place a margin limit or market order.
 * Uses @mysten/deepbook-v3 poolProxy.placeLimitOrder / placeMarketOrder.
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/orders
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

  const db = (
    extended as {
      deepbook: {
        poolProxy: {
          placeLimitOrder: (p: {
            poolKey: string;
            marginManagerKey: string;
            clientOrderId: number;
            price: number;
            quantity: number;
            isBid: boolean;
            payWithDeep?: boolean;
          }) => (tx: Transaction) => void;
          placeMarketOrder: (p: {
            poolKey: string;
            marginManagerKey: string;
            clientOrderId: number;
            quantity: number;
            isBid: boolean;
            payWithDeep?: boolean;
          }) => (tx: Transaction) => void;
        };
      };
    }
  ).deepbook;
  const poolProxy = db.poolProxy;

  if (orderType === "limit") {
    poolProxy.placeLimitOrder({
      poolKey,
      marginManagerKey: MANAGER_KEY,
      clientOrderId,
      price: price!,
      quantity,
      isBid,
      payWithDeep,
    })(tx);
  } else {
    poolProxy.placeMarketOrder({
      poolKey,
      marginManagerKey: MANAGER_KEY,
      clientOrderId,
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
