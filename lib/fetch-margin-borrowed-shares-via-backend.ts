/**
 * Fetch margin manager state from chain via backend (getObject + optional devInspect).
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/margin-manager#borrowedshares-borrowedbaseshares-borrowedquoteshares-hasbasedebt
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/margin-manager#balancemanager-calculateassets-calculatedebts
 */

export type MarginBorrowedSharesResponse = {
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
  _debug?: { resultCount: number };
};

export async function fetchMarginBorrowedSharesViaBackend(params: {
  apiUrl: string;
  marginManagerId: string;
  /** Pool key (e.g. SUI_USDC). Required for SDK. */
  poolKey: string;
  network?: "mainnet" | "testnet";
  debug?: boolean;
}): Promise<MarginBorrowedSharesResponse> {
  const { apiUrl, marginManagerId, poolKey, network = "mainnet", debug } = params;
  const base = apiUrl.replace(/\/$/, "");
  const search = new URLSearchParams({
    marginManagerId,
    poolKey,
    network,
  });
  if (debug) search.set("debug", "1");
  const url = `${base}/api/margin-borrowed-shares?${search.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      (json.error as string) ?? "Failed to fetch margin borrowed shares"
    );
  }
  return json as MarginBorrowedSharesResponse;
}
