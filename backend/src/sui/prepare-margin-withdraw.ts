/**
 * Build a Sui transaction to withdraw base, quote, or DEEP from a margin manager.
 * Withdrawals are subject to risk ratio limits on-chain.
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
import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2.js";
import { Buffer } from "buffer";

const MANAGER_KEY = "MARGIN_MANAGER_1";

export type PrepareMarginWithdrawParams = {
  sender: string;
  marginManagerId: string;
  poolKey: string;
  asset: "base" | "quote" | "deep";
  amount: number; // human amount
  network?: "mainnet" | "testnet";
};

export type PrepareMarginWithdrawResult = {
  intentMessageHashHex: string;
  txBytesBase64: string;
};

/** Minimum withdraw in human units (0.01 token); decimals handled by SDK via coin.scalar. */
export const MIN_WITHDRAW_AMOUNT = 0.01;

export async function prepareMarginWithdraw(
  params: PrepareMarginWithdrawParams
): Promise<PrepareMarginWithdrawResult> {
  const {
    sender,
    marginManagerId,
    poolKey,
    asset,
    amount,
    network = "mainnet",
  } = params;

  if (amount < MIN_WITHDRAW_AMOUNT) {
    throw new Error(
      `Amount must be at least ${MIN_WITHDRAW_AMOUNT} (got ${amount})`
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
          withdrawBase: (
            key: string,
            amount: number
          ) => (tx: Transaction) => unknown;
          withdrawQuote: (
            key: string,
            amount: number
          ) => (tx: Transaction) => unknown;
          withdrawDeep: (
            key: string,
            amount: number
          ) => (tx: Transaction) => unknown;
        };
      };
    }
  ).deepbook;
  const marginManager = db.marginManager;

  let withdrawnCoin: TransactionObjectArgument;
  if (asset === "base") {
    withdrawnCoin = marginManager.withdrawBase(MANAGER_KEY, amount)(tx) as TransactionObjectArgument;
  } else if (asset === "quote") {
    withdrawnCoin = marginManager.withdrawQuote(MANAGER_KEY, amount)(tx) as TransactionObjectArgument;
  } else {
    withdrawnCoin = marginManager.withdrawDeep(MANAGER_KEY, amount)(tx) as TransactionObjectArgument;
  }
  tx.transferObjects([withdrawnCoin], tx.pure.address(sender));

  const txBytes = await tx.build({ client });
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHashHex, txBytesBase64 };
}
