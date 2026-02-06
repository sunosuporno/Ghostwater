/**
 * LI.FI API: quote and status for cross-chain transfers.
 * - Quote: https://li.quest/v1/quote
 * - Status: https://li.quest/v1/status (track bridge and get destination tx)
 */

const LIFI_BASE = "https://li.quest/v1";
const LIFI_QUOTE_URL = `${LIFI_BASE}/quote`;
const LIFI_STATUS_URL = `${LIFI_BASE}/status`;

export type LifiQuoteParams = {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAmount: string;
  fromAddress: string;
  toAddress?: string;
  slippage?: number;
};

/**
 * Request a quote from LI.FI for a cross-chain transfer.
 * fromAmount must be in the token's smallest unit (e.g. wei for ETH).
 * Returns the raw API response; throws on HTTP error or API error.
 */
export async function fetchLifiQuote(
  params: LifiQuoteParams
): Promise<unknown> {
  const search = new URLSearchParams();
  search.set("fromChain", String(params.fromChainId));
  search.set("toChain", String(params.toChainId));
  search.set("fromToken", params.fromTokenAddress);
  search.set("toToken", params.toTokenAddress);
  search.set("fromAmount", params.fromAmount);
  search.set("fromAddress", params.fromAddress);
  if (params.toAddress) search.set("toAddress", params.toAddress);
  if (params.slippage != null) search.set("slippage", String(params.slippage));

  const url = `${LIFI_QUOTE_URL}?${search.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LI.FI quote failed (${res.status}): ${text || res.statusText}`);
  }

  return res.json();
}

// --- Status (track bridge + destination tx) ---

export type LifiStatusResponse = {
  transactionId?: string;
  status: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
  substatus?: string;
  substatusMessage?: string;
  sending?: {
    txHash: string;
    txLink: string;
    amount: string;
    token?: { symbol: string; decimals?: number; chainId?: number };
    chainId?: number;
  };
  receiving?: {
    txHash: string;
    txLink: string;
    amount: string;
    token?: { symbol: string; decimals?: number; chainId?: number };
    chainId?: number;
  };
  lifiExplorerLink?: string;
  fromAddress?: string;
  toAddress?: string;
  tool?: string;
};

/**
 * Check status of a cross-chain transfer by source chain tx hash.
 * Pass fromChainId (e.g. 8453 for Base) to speed up the request.
 * Returns 200 even when tx not found yet (status NOT_FOUND).
 */
export async function fetchLifiStatus(
  txHash: string,
  fromChainId?: number
): Promise<LifiStatusResponse> {
  const search = new URLSearchParams();
  search.set("txHash", txHash);
  if (fromChainId != null) search.set("fromChain", String(fromChainId));

  const url = `${LIFI_STATUS_URL}?${search.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LI.FI status failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}
