import * as SecureStore from "expo-secure-store";

const KEY_PREFIX = "ghostwater_margin_manager";
const SELECTED_PREFIX = "ghostwater_selected_margin";

/** Key for storing a single margin manager ID per wallet (one pool supported for now). */
function storageKey(suiAddress: string): string {
  return `${KEY_PREFIX}_${suiAddress.toLowerCase()}`;
}

/** Key for storing which margin manager the user chose for a given pool (when they have multiple). */
function selectedStorageKey(suiAddress: string, poolKey: string): string {
  return `${SELECTED_PREFIX}_${suiAddress.toLowerCase()}_${poolKey.toUpperCase()}`;
}

export interface StoredMarginManager {
  margin_manager_id: string;
  deepbook_pool_id: string;
  base_margin_pool_id: string;
  quote_margin_pool_id: string;
}

export async function getStoredMarginManager(
  suiAddress: string | null
): Promise<StoredMarginManager | null> {
  if (!suiAddress) return null;
  try {
    const raw = await SecureStore.getItemAsync(storageKey(suiAddress));
    if (!raw) return null;
    return JSON.parse(raw) as StoredMarginManager;
  } catch {
    return null;
  }
}

export async function setStoredMarginManager(
  suiAddress: string,
  data: StoredMarginManager
): Promise<void> {
  await SecureStore.setItemAsync(storageKey(suiAddress), JSON.stringify(data));
}

export async function clearStoredMarginManager(
  suiAddress: string
): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(suiAddress));
}

/** Get the user's chosen margin manager ID for this pool (when they have multiple). */
export async function getSelectedMarginManagerId(
  suiAddress: string | null,
  poolKey: string
): Promise<string | null> {
  if (!suiAddress || !poolKey) return null;
  try {
    return await SecureStore.getItemAsync(
      selectedStorageKey(suiAddress, poolKey)
    );
  } catch {
    return null;
  }
}

/** Save the user's chosen margin manager ID for this pool. */
export async function setSelectedMarginManagerId(
  suiAddress: string,
  poolKey: string,
  marginManagerId: string
): Promise<void> {
  await SecureStore.setItemAsync(
    selectedStorageKey(suiAddress, poolKey),
    marginManagerId
  );
}
