/**
 * Build a Sui transfer transaction and return intent message (for client to sign)
 * and raw tx bytes (for execute step). Uses @mysten/sui (runs only on backend).
 */

import { messageWithIntent } from "@mysten/sui/cryptography";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { bytesToHex } from "@noble/hashes/utils";

const SUI_COIN_TYPE = "0x2::sui::SUI";
const GAS_BUDGET_RESERVE_MIST = 100_000_000n;

export type PrepareTransferParams = {
  sender: string;
  recipient: string;
  coinType: string;
  amountMist: string; // decimal string for JSON
  network?: "mainnet" | "testnet";
};

export type PrepareTransferResult = {
  intentMessageHex: string;
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
  const amountMist = BigInt(amountStr);

  if (amountMist <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });

  const tx = new Transaction();
  tx.setSender(sender);

  const balanceRes = await client.core.getBalance({ owner: sender, coinType });
  const totalBalance = BigInt(balanceRes.totalBalance);

  const isSui = coinType === SUI_COIN_TYPE;
  if (isSui) {
    const maxTransfer =
      totalBalance > GAS_BUDGET_RESERVE_MIST
        ? totalBalance - GAS_BUDGET_RESERVE_MIST
        : 0n;
    if (amountMist > maxTransfer) {
      throw new Error(
        `Amount exceeds available balance (max ${maxTransfer} mist after gas reserve)`
      );
    }
    const [coin] = tx.splitCoins(tx.gas, [amountMist]);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    const { data: coins } = await client.core.listCoins({
      owner: sender,
      coinType,
    });
    if (!coins?.length) throw new Error("No coins to transfer");
    const totalAvailable = coins.reduce(
      (sum, c) => sum + BigInt(c.balance ?? 0),
      0n
    );
    if (amountMist > totalAvailable) throw new Error("Amount exceeds balance");
    const coinRefs = coins.map((c) => c.coinObjectId);
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
  const intentMessageHex = "0x" + bytesToHex(intentMessage);
  const txBytesBase64 = Buffer.from(txBytes).toString("base64");

  return { intentMessageHex, txBytesBase64 };
}
