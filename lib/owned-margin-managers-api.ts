/**
 * Fetch margin managers owned by an address from the backend (chain discovery, no DB).
 */

export type OwnedMarginManagerEntry = {
  margin_manager_id: string;
  deepbook_pool_id: string;
};

export type OwnedMarginManagersResponse = {
  managers: OwnedMarginManagerEntry[];
};

const DEFAULT_NETWORK = "mainnet";

export async function fetchOwnedMarginManagers(params: {
  apiUrl: string;
  owner: string;
  network?: "mainnet" | "testnet";
}): Promise<OwnedMarginManagersResponse> {
  const { apiUrl, owner, network = DEFAULT_NETWORK } = params;
  const base = apiUrl.replace(/\/$/, "");
  const url = `${base}/api/owned-margin-managers?owner=${encodeURIComponent(
    owner
  )}&network=${network}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      (json.error as string) ?? "Failed to fetch owned margin managers"
    );
  }
  const managers = Array.isArray(json.managers) ? json.managers : [];
  return { managers };
}
