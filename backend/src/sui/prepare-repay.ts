/**
 * Build a Sui transaction to repay base and/or quote debt on a margin manager.
 * Uses repayBase and repayQuote from the margin manager (optional amount = repay all).
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/margin-manager#repaybase-repayquote
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

export type PrepareRepayParams = {
  sender: string;
  marginManagerId: string;
  poolKey: string;
  /** Base debt to repay (e.g. SUI). Human units. Omit or 0 to skip. */
  baseAmount?: number;
  /** Quote debt to repay (e.g. USDC). Human units. Omit or 0 to skip. */
  quoteAmount?: number;
  network?: "mainnet" | "testnet";
};

export type PrepareRepayResult = {
  intentMessageHashHex: string;
  txBytesBase64: string;
};

export async function prepareRepay(
  params: PrepareRepayParams
): Promise<PrepareRepayResult> {
  const {
    sender,
    marginManagerId,
    poolKey,
    baseAmount = 0,
    quoteAmount = 0,
    network = "mainnet",
  } = params;

  const doBase = baseAmount != null && baseAmount > 0;
  const doQuote = quoteAmount != null && quoteAmount > 0;
  if (!doBase && !doQuote) {
    throw new Error(
      "At least one of baseAmount or quoteAmount must be positive"
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
          repayBase: (
            key: string,
            amount?: number
          ) => (tx: Transaction) => void;
          repayQuote: (
            key: string,
            amount?: number
          ) => (tx: Transaction) => void;
        };
      };
    }
  ).deepbook;
  const marginManager = db.marginManager;

  if (doBase) {
    marginManager.repayBase(MANAGER_KEY, baseAmount)(tx);
  }
  if (doQuote) {
    marginManager.repayQuote(MANAGER_KEY, quoteAmount)(tx);
  }

  const txBytes = await tx.build({ client });
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHash = blake2b(intentMessage, { dkLen: 32 });
  const intentMessageHashHex = "0x" + Buffer.from(intentHash).toString("hex");
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHashHex, txBytesBase64 };
}
