/**
 * Sui transfer helpers: get balance, build "send full balance" tx, sign with Privy and execute.
 * Uses @mysten/sui client + Transaction; signing via Privy useSignRawHash (Tier 2 Sui).
 */

import {
  messageWithIntent,
  toSerializedSignature,
} from "@mysten/sui/cryptography";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { publicKeyFromRawBytes } from "@mysten/sui/verify";
import { bytesToHex } from "@noble/hashes/utils";

const SUI_COIN_TYPE = "0x2::sui::SUI";
const GAS_BUDGET_RESERVE_MIST = 100_000_000n; // 0.1 SUI reserved for gas when sending full SUI

export type SuiClientNetwork = "mainnet" | "testnet";

export function getSuiClient(
  network: SuiClientNetwork = "mainnet"
): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network), network });
}

/**
 * Get total balance for a coin type owned by an address.
 */
export async function getBalance(
  client: SuiJsonRpcClient,
  owner: string,
  coinType: string
): Promise<{ totalBalance: string; coinType: string }> {
  const res = await client.core.getBalance({ owner, coinType });
  return {
    totalBalance: res.totalBalance,
    coinType: res.coinType,
  };
}

/**
 * Build a Transaction that transfers the full balance of the given coin type
 * from sender to recipient. For SUI, reserves GAS_BUDGET_RESERVE_MIST for gas.
 */
export async function buildTransferFullBalanceTx(
  client: SuiJsonRpcClient,
  sender: string,
  recipient: string,
  coinType: string
): Promise<Transaction> {
  const tx = new Transaction();
  tx.setSender(sender);

  const balanceRes = await getBalance(client, sender, coinType);
  const totalBalance = BigInt(balanceRes.totalBalance);
  if (totalBalance === 0n) {
    throw new Error("No balance to transfer");
  }

  const isSui = coinType === SUI_COIN_TYPE;
  if (isSui) {
    // Transfer (total - gas reserve); gas coin pays for the tx
    const transferAmount =
      totalBalance > GAS_BUDGET_RESERVE_MIST
        ? totalBalance - GAS_BUDGET_RESERVE_MIST
        : 0n;
    if (transferAmount === 0n) {
      throw new Error("Balance too low to transfer (need reserve for gas)");
    }
    const [coin] = tx.splitCoins(tx.gas, [transferAmount]);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    // Non-SUI: list coin objects and transfer all
    const { data: coins } = await client.core.listCoins({
      owner: sender,
      coinType,
    });
    if (!coins?.length) {
      throw new Error("No coins to transfer");
    }
    const coinRefs = coins.map((c) => c.coinObjectId);
    tx.transferObjects(
      coinRefs.map((id) => tx.object(id)),
      tx.pure.address(recipient)
    );
  }

  return tx;
}

/**
 * Build a Transaction that transfers a specific amount of the given coin type
 * from sender to recipient. For SUI, reserves gas from the same coin.
 */
export async function buildTransferAmountTx(
  client: SuiJsonRpcClient,
  sender: string,
  recipient: string,
  coinType: string,
  amountMist: bigint
): Promise<Transaction> {
  const tx = new Transaction();
  tx.setSender(sender);

  if (amountMist <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  const isSui = coinType === SUI_COIN_TYPE;
  if (isSui) {
    const balanceRes = await getBalance(client, sender, coinType);
    const totalBalance = BigInt(balanceRes.totalBalance);
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
    if (!coins?.length) {
      throw new Error("No coins to transfer");
    }
    const totalAvailable = coins.reduce(
      (sum, c) => sum + BigInt(c.balance ?? 0),
      0n
    );
    if (amountMist > totalAvailable) {
      throw new Error("Amount exceeds balance");
    }
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

  return tx;
}

/**
 * Sign the transaction bytes with Privy's raw sign (Sui intent: TransactionData + blake2b256),
 * then execute. Requires wallet address, signRawHash from useSignRawHash, and public key (raw 32 bytes for ED25519).
 */
export async function signAndExecuteWithPrivy(
  client: SuiJsonRpcClient,
  txBytes: Uint8Array,
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    bytes: string;
    encoding: "hex";
    hash_function: "blake2b256";
  }) => Promise<{ signature: string }>,
  senderAddress: string,
  publicKeyRawBytes: Uint8Array
): Promise<{ digest: string }> {
  const intentMessage = messageWithIntent("TransactionData", txBytes);
  const intentHex = "0x" + bytesToHex(intentMessage);

  const { signature: sigHex } = await signRawHash({
    address: senderAddress,
    chainType: "sui",
    bytes: intentHex,
    encoding: "hex",
    hash_function: "blake2b256",
  });

  // Privy returns hex "0x..."; decode to raw bytes for toSerializedSignature
  const sigBytes = hexToBytes(sigHex);
  const publicKey = publicKeyFromRawBytes("ED25519", publicKeyRawBytes);
  const serializedSig = toSerializedSignature({
    signature: sigBytes,
    signatureScheme: "ED25519",
    publicKey,
  });

  const result = await client.core.executeTransaction({
    transaction: txBytes,
    signatures: [serializedSig],
    include: { effects: true },
  });

  if (result.$kind === "FailedTransaction") {
    const err =
      result.FailedTransaction.effects?.status &&
      "error" in result.FailedTransaction.effects.status
        ? (result.FailedTransaction.effects.status as { error?: string }).error
        : "Transaction failed";
    throw new Error(err ?? "Transaction failed");
  }

  return { digest: result.Transaction.digest };
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const len = h.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode a public key to raw 32 bytes for ED25519.
 * Accepts hex (0x + 64 chars) or Uint8Array (32 bytes).
 * For base58 (e.g. from Privy), decode externally and pass hex or bytes.
 */
export function decodePublicKeyToRawBytes(
  publicKey: string | Uint8Array
): Uint8Array {
  if (publicKey instanceof Uint8Array) {
    return publicKey.length === 32 ? publicKey : publicKey;
  }
  const s = publicKey.trim();
  if (s.startsWith("0x") && s.length === 66) {
    return hexToBytes(s);
  }
  if (s.length === 64 && /^[0-9a-fA-F]+$/.test(s)) {
    return hexToBytes("0x" + s);
  }
  throw new Error(
    "Invalid public key: expected hex (0x + 64 chars) or 32 bytes"
  );
}
