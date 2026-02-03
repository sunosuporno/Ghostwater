/**
 * Build a Sui transaction to deposit base, quote, or DEEP into a margin manager.
 * Uses @mysten/deepbook-v3; CoinWithBalance is resolved at build({ client }) so sender must have balance.
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

export type PrepareMarginDepositParams = {
  sender: string;
  marginManagerId: string;
  poolKey: string;
  asset: "base" | "quote" | "deep";
  amount: number; // human amount (e.g. 10 for 10 USDC)
  network?: "mainnet" | "testnet";
};

export type PrepareMarginDepositResult = {
  intentMessageHashHex: string;
  txBytesBase64: string;
};

/** Minimum deposit in human units (0.01 token); decimals handled by SDK via coin.scalar. */
export const MIN_DEPOSIT_AMOUNT = 0.01;

export async function prepareMarginDeposit(
  params: PrepareMarginDepositParams
): Promise<PrepareMarginDepositResult> {
  const {
    sender,
    marginManagerId,
    poolKey,
    asset,
    amount,
    network = "mainnet",
  } = params;

  if (amount < MIN_DEPOSIT_AMOUNT) {
    throw new Error(
      `Amount must be at least ${MIN_DEPOSIT_AMOUNT} (got ${amount})`
    );
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
        marginManager: {
          depositBase: (p: object) => (tx: Transaction) => void;
          depositQuote: (p: object) => (tx: Transaction) => void;
          depositDeep: (p: object) => (tx: Transaction) => void;
        };
      };
    }
  ).deepbook;
  const marginManager = db.marginManager;
  const depositParams = { managerKey: MANAGER_KEY, amount };

  if (asset === "base") {
    marginManager.depositBase(depositParams)(tx);
  } else if (asset === "quote") {
    marginManager.depositQuote(depositParams)(tx);
  } else {
    marginManager.depositDeep(depositParams)(tx);
  }

  const txBytes = await tx.build({ client });
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHashHex, txBytesBase64 };
}
