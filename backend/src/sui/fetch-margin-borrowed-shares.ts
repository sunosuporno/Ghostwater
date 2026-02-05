/**
 * Read margin manager state using @mysten/deepbook-v3 SDK read-only methods.
 * Builds a transaction with SDK moveCalls, runs devInspect, decodes return values.
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/margin-manager#owner-deepbookpool-marginpoolid
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/margin-manager#borrowedshares-borrowedbaseshares-borrowedquoteshares-hasbasedebt
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/margin-manager#balancemanager-calculateassets-calculatedebts
 */

import {
  deepbook,
  mainnetCoins,
  mainnetPools,
  testnetCoins,
  testnetPools,
} from "@mysten/deepbook-v3";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const MANAGER_KEY = "MARGIN_MANAGER_1";

export type MarginBorrowedSharesParams = {
  marginManagerId: string;
  /** Pool key (e.g. SUI_USDC). Required for SDK type args and pool/margin pool resolution. */
  poolKey: string;
  network?: "mainnet" | "testnet";
  /** If true, result includes _debug with raw result indices. */
  debug?: boolean;
};

export type MarginBorrowedSharesResult = {
  margin_manager_id: string;
  owner: string | null;
  deepbookPool: string | null;
  marginPoolId: string | null;
  borrowedShares: { base: string; quote: string };
  borrowedBaseShares: string;
  borrowedQuoteShares: string;
  hasBaseDebt: boolean;
  balanceManager: { id: string } | null;
  calculateAssets: { base_asset: string; quote_asset: string } | null;
  calculateDebts: { base_debt: string; quote_debt: string } | null;
  source: "chain";
  _debug?: {
    resultCount: number;
    /** When debug=true: raw BCS return bytes (hex) and our decoded value per moveCall. */
    rawReturns?: Array<{
      index: number;
      name: string;
      rawHex: string;
      rawLength: number;
      decoded: unknown;
      note?: string;
    }>;
    /** When debug=true: debt fields read directly from margin manager object (getObject). Confirms if debt is really 0. */
    debtVerify?: {
      fromObject: Record<string, unknown>;
      note: string;
    };
  };
};

function bytesToHex(data: number[]): string {
  if (data.length === 0) return "0x";
  const hex = data.map((b) => b.toString(16).padStart(2, "0")).join("");
  return "0x" + hex;
}

function u64LE(data: number[]): bigint {
  return data.reduce((acc, b, i) => acc + (BigInt(b) << BigInt(i * 8)), 0n);
}

function decodeU64(data: number[], offset: number): string {
  return String(u64LE(data.slice(offset, offset + 8)));
}

function decodeU64Tuple(data: number[]): [string, string] | null {
  if (data.length < 16) return null;
  return [decodeU64(data, 0), decodeU64(data, 8)];
}

function decodeAddress(data: number[]): string {
  if (data.length < 32) return "";
  const hex = Array.from(data.slice(0, 32))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "0x" + hex;
}

function decodeOptionId(data: number[]): string | null {
  if (data.length < 1) return null;
  if (data[0] === 0) return null;
  if (data.length < 33) return null;
  return decodeAddress(data.slice(1, 33));
}

function decodeBool(data: number[]): boolean {
  return data.length > 0 && data[0] !== 0;
}

export async function fetchMarginBorrowedShares(
  params: MarginBorrowedSharesParams
): Promise<MarginBorrowedSharesResult> {
  const { marginManagerId, poolKey, network = "mainnet", debug: debugParam = false } = params;

  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });

  const pools = network === "mainnet" ? mainnetPools : testnetPools;
  const coins = network === "mainnet" ? mainnetCoins : testnetCoins;

  if (!(poolKey in pools)) {
    throw new Error(
      `Unknown poolKey: ${poolKey}. Valid keys: ${Object.keys(pools).slice(0, 10).join(", ")}`
    );
  }

  const extended = client.$extend(
    deepbook({
      address: marginManagerId,
      pools,
      coins,
      marginManagers: {
        [MANAGER_KEY]: { address: marginManagerId, poolKey },
      },
    })
  );

  const db = (extended as { deepbook: { marginManager: MarginManagerContract } }).deepbook;
  const mm = db.marginManager;
  const pool = pools[poolKey as keyof typeof pools];

  const tx = new Transaction();
  tx.setSender(marginManagerId);

  // Order of moveCalls = order of results[] from devInspect (main batch: everything except calculateDebts)
  mm.ownerByPoolKey(poolKey, marginManagerId)(tx);
  mm.deepbookPool(poolKey, marginManagerId)(tx);
  mm.marginPoolId(poolKey, marginManagerId)(tx);
  mm.borrowedShares(poolKey, marginManagerId)(tx);
  mm.borrowedBaseShares(poolKey, marginManagerId)(tx);
  mm.borrowedQuoteShares(poolKey, marginManagerId)(tx);
  mm.hasBaseDebt(poolKey, marginManagerId)(tx);
  mm.balanceManager(poolKey, marginManagerId)(tx);
  mm.calculateAssets(poolKey, marginManagerId)(tx);

  const inspect = await client.devInspectTransactionBlock({
    sender: marginManagerId,
    transactionBlock: tx,
  });

  const results = inspect.results ?? [];
  if (inspect.error) {
    throw new Error(`devInspect failed: ${inspect.error}`);
  }

  /** Single return value: first [bytes, type] pair's bytes. */
  const getReturnBytes = (index: number): number[] | null => {
    if (index >= results.length || !results[index].returnValues?.length) return null;
    const tuple = results[index].returnValues![0];
    const data = Array.isArray(tuple) && tuple.length > 0 ? tuple[0] : null;
    return Array.isArray(data) ? data : null;
  };

  /** All return value bytes for one moveCall (e.g. (u64, u64) => [bytes1, bytes2]). */
  const getAllReturnBytes = (index: number): number[][] => {
    if (index >= results.length || !results[index].returnValues?.length) return [];
    return (results[index].returnValues ?? [])
      .map(([bytes]: [number[], string]) => (Array.isArray(bytes) ? bytes : []))
      .filter((b: number[]) => b.length > 0);
  };

  const ownerBytes = getReturnBytes(0);
  const deepbookPoolBytes = getReturnBytes(1);
  const marginPoolIdBytes = getReturnBytes(2);
  const borrowedSharesBytes = getReturnBytes(3);
  const borrowedBaseSharesBytes = getReturnBytes(4);
  const borrowedQuoteSharesBytes = getReturnBytes(5);
  const hasBaseDebtBytes = getReturnBytes(6);
  const balanceManagerBytes = getReturnBytes(7);
  const calculateAssetsParts = getAllReturnBytes(8);

  const borrowedSharesTuple =
    borrowedSharesBytes && borrowedSharesBytes.length >= 16
      ? decodeU64Tuple(borrowedSharesBytes)
      : null;
  const borrowedBaseShares =
    borrowedBaseSharesBytes && borrowedBaseSharesBytes.length >= 8
      ? decodeU64(borrowedBaseSharesBytes, 0)
      : "0";
  const borrowedQuoteShares =
    borrowedQuoteSharesBytes && borrowedQuoteSharesBytes.length >= 8
      ? decodeU64(borrowedQuoteSharesBytes, 0)
      : "0";
  const hasBaseDebt = hasBaseDebtBytes ? decodeBool(hasBaseDebtBytes) : false;

  let balanceManagerId: string | null = null;
  if (balanceManagerBytes && balanceManagerBytes.length >= 32) {
    balanceManagerId = decodeAddress(balanceManagerBytes);
  }
  // balanceManager return is a full struct (e.g. 201 bytes); we only use first 32 bytes as id

  let calculateAssets: MarginBorrowedSharesResult["calculateAssets"] = null;
  if (calculateAssetsParts.length >= 2) {
    const base = calculateAssetsParts[0].length >= 8 ? decodeU64(calculateAssetsParts[0], 0) : "0";
    const quote = calculateAssetsParts[1].length >= 8 ? decodeU64(calculateAssetsParts[1], 0) : "0";
    calculateAssets = { base_asset: base, quote_asset: quote };
  } else if (calculateAssetsParts.length === 1) {
    const b = calculateAssetsParts[0];
    if (b.length >= 16) {
      const pair = decodeU64Tuple(b);
      if (pair) calculateAssets = { base_asset: pair[0], quote_asset: pair[1] };
    } else if (b.length >= 8) {
      const single = decodeU64(b, 0);
      calculateAssets = { base_asset: single, quote_asset: "0" };
    }
  }

  // Optional second devInspect just for calculateDebts. We run it in a separate batch so that
  // aborts (e.g. when there is no debt yet) do NOT poison the main result set.
  let calculateDebts: MarginBorrowedSharesResult["calculateDebts"] = null;
  try {
    const txDebts = new Transaction();
    txDebts.setSender(marginManagerId);
    // One call for base debt, one for quote debt.
    mm.calculateDebts(poolKey, pool.baseCoin, marginManagerId)(txDebts);
    mm.calculateDebts(poolKey, pool.quoteCoin, marginManagerId)(txDebts);

    const inspectDebts = await client.devInspectTransactionBlock({
      sender: marginManagerId,
      transactionBlock: txDebts,
    });
    if (!inspectDebts.error) {
      const debtResults = inspectDebts.results ?? [];
      const getDebtValue = (idx: number): string | null => {
        if (idx >= debtResults.length || !debtResults[idx].returnValues?.length) return null;
        const [bytes] = debtResults[idx].returnValues![0] as [number[], string];
        if (!Array.isArray(bytes) || bytes.length < 8) return null;
        return decodeU64(bytes, 0);
      };
      const baseDebt = getDebtValue(0) ?? "0";
      const quoteDebt = getDebtValue(1) ?? "0";
      if (baseDebt !== "0" || quoteDebt !== "0") {
        calculateDebts = { base_debt: baseDebt, quote_debt: quoteDebt };
      }
    }
    // If inspectDebts.error is set, we silently ignore and leave calculateDebts = null.
  } catch {
    // devInspect for calculateDebts can abort (e.g. when there is no debt or pool not linked).
    // We treat that as "no readable on-chain debt" and keep calculateDebts = null.
  }

  // One-off debt verification: read margin manager object directly (getObject) when debug=true
  let debtVerify: { fromObject: Record<string, unknown>; note: string } | undefined;
  if (debugParam) {
    try {
      const obj = await client.getObject({
        id: marginManagerId,
        options: { showContent: true },
      });
      const content = obj.data?.content as { dataType?: string; fields?: Record<string, unknown> } | undefined;
      const fields = content?.dataType === "moveObject" ? content.fields : undefined;
      if (fields) {
        const debtFields: Record<string, unknown> = {};
        for (const key of ["borrowed_base_shares", "borrowed_quote_shares", "has_base_debt"]) {
          if (key in fields) debtFields[key] = fields[key];
        }
        debtVerify = {
          fromObject: Object.keys(debtFields).length ? debtFields : (fields as Record<string, unknown>),
          note: "getObject(showContent:true) on margin manager; debt = 0 if borrowed_*_shares are 0",
        };
      } else {
        debtVerify = { fromObject: {}, note: "getObject: no moveObject content (object may be wrapped or different type)" };
      }
    } catch (e) {
      debtVerify = { fromObject: {}, note: "getObject failed: " + (e instanceof Error ? e.message : String(e)) };
    }
  }

  const out: MarginBorrowedSharesResult = {
    margin_manager_id: marginManagerId,
    owner: ownerBytes ? decodeAddress(ownerBytes) : null,
    deepbookPool: deepbookPoolBytes ? decodeAddress(deepbookPoolBytes) : null,
    marginPoolId: marginPoolIdBytes ? decodeOptionId(marginPoolIdBytes) : null,
    borrowedShares: borrowedSharesTuple
      ? { base: borrowedSharesTuple[0], quote: borrowedSharesTuple[1] }
      : { base: borrowedBaseShares, quote: borrowedQuoteShares },
    borrowedBaseShares,
    borrowedQuoteShares,
    hasBaseDebt,
    balanceManager: balanceManagerId ? { id: balanceManagerId } : null,
    calculateAssets,
    calculateDebts,
    source: "chain",
    ...(debugParam && {
      _debug: {
        resultCount: results.length,
        ...(debtVerify && { debtVerify }),
        rawReturns: [
          {
            index: 0,
            name: "owner",
            rawHex: ownerBytes ? bytesToHex(ownerBytes) : "(none)",
            rawLength: ownerBytes?.length ?? 0,
            decoded: ownerBytes ? decodeAddress(ownerBytes) : null,
          },
          {
            index: 1,
            name: "deepbookPool",
            rawHex: deepbookPoolBytes ? bytesToHex(deepbookPoolBytes) : "(none)",
            rawLength: deepbookPoolBytes?.length ?? 0,
            decoded: deepbookPoolBytes ? decodeAddress(deepbookPoolBytes) : null,
          },
          {
            index: 2,
            name: "marginPoolId",
            rawHex: marginPoolIdBytes ? bytesToHex(marginPoolIdBytes) : "(none)",
            rawLength: marginPoolIdBytes?.length ?? 0,
            decoded: marginPoolIdBytes ? decodeOptionId(marginPoolIdBytes) : null,
          },
          {
            index: 3,
            name: "borrowedShares",
            rawHex: borrowedSharesBytes ? bytesToHex(borrowedSharesBytes) : "(none)",
            rawLength: borrowedSharesBytes?.length ?? 0,
            decoded: borrowedSharesTuple
              ? { base: borrowedSharesTuple[0], quote: borrowedSharesTuple[1] }
              : { base: borrowedBaseShares, quote: borrowedQuoteShares },
            ...(borrowedSharesBytes && borrowedSharesBytes.length !== 16 && {
              note: "expected 16 bytes (u64,u64); got " + borrowedSharesBytes.length,
            }),
          },
          {
            index: 4,
            name: "borrowedBaseShares",
            rawHex: borrowedBaseSharesBytes ? bytesToHex(borrowedBaseSharesBytes) : "(none)",
            rawLength: borrowedBaseSharesBytes?.length ?? 0,
            decoded: borrowedBaseShares,
          },
          {
            index: 5,
            name: "borrowedQuoteShares",
            rawHex: borrowedQuoteSharesBytes ? bytesToHex(borrowedQuoteSharesBytes) : "(none)",
            rawLength: borrowedQuoteSharesBytes?.length ?? 0,
            decoded: borrowedQuoteShares,
          },
          {
            index: 6,
            name: "hasBaseDebt",
            rawHex: hasBaseDebtBytes ? bytesToHex(hasBaseDebtBytes) : "(none)",
            rawLength: hasBaseDebtBytes?.length ?? 0,
            decoded: hasBaseDebt,
          },
          {
            index: 7,
            name: "balanceManager",
            rawHex: balanceManagerBytes ? bytesToHex(balanceManagerBytes) : "(none)",
            rawLength: balanceManagerBytes?.length ?? 0,
            decoded: balanceManagerId ? { id: balanceManagerId } : null,
            ...(balanceManagerBytes && balanceManagerBytes.length > 32 && {
              note: "only first 32 bytes decoded as id; full return is struct (" + balanceManagerBytes.length + " bytes)",
            }),
          },
          {
            index: 8,
            name: "calculateAssets",
            rawHex:
              calculateAssetsParts.length > 0
                ? calculateAssetsParts.map((p) => bytesToHex(p)).join(" | ")
                : "(none)",
            rawLength: calculateAssetsParts.reduce((s, p) => s + p.length, 0),
            decoded: calculateAssets,
            ...(calculateAssetsParts.length >= 2 && {
              note: "two return values (base_asset, quote_asset)",
            }),
          },
        ],
      },
    }),
  };

  console.log(
    "======= Margin Manager SDK — borrowedShares, borrowedBaseShares, borrowedQuoteShares, hasBaseDebt ======="
  );
  console.log(
    JSON.stringify(
      {
        borrowedShares: out.borrowedShares,
        borrowedBaseShares: out.borrowedBaseShares,
        borrowedQuoteShares: out.borrowedQuoteShares,
        hasBaseDebt: out.hasBaseDebt,
      },
      null,
      2
    )
  );
  console.log(
    "+++++++ Margin Manager SDK — owner, deepbookPool, marginPoolId, balanceManager, calculateAssets, calculateDebts +++++++"
  );
  console.log(
    JSON.stringify(
      {
        owner: out.owner,
        deepbookPool: out.deepbookPool,
        marginPoolId: out.marginPoolId,
        balanceManager: out.balanceManager,
        calculateAssets: out.calculateAssets,
        calculateDebts: out.calculateDebts,
      },
      null,
      2
    )
  );
  if (debugParam && out._debug?.rawReturns) {
    console.log("======= Raw devInspect returns (hex + decoded) =======");
    console.log(JSON.stringify(out._debug.rawReturns, null, 2));
  }
  if (debugParam && out._debug?.debtVerify) {
    console.log("======= Debt verification (getObject on margin manager) =======");
    console.log(JSON.stringify(out._debug.debtVerify, null, 2));
  }
  return out;
}

type MarginManagerContract = {
  ownerByPoolKey: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  deepbookPool: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  marginPoolId: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  borrowedShares: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  borrowedBaseShares: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  borrowedQuoteShares: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  hasBaseDebt: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  balanceManager: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  calculateAssets: (poolKey: string, marginManagerId: string) => (tx: Transaction) => unknown;
  calculateDebts: (
    poolKey: string,
    coinKey: string,
    marginManagerId: string
  ) => (tx: Transaction) => unknown;
};
