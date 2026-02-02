type LinkedAccount = {
  type?: string;
  chain_type?: string;
  chainType?: string;
  address?: string;
  public_key?: string;
  publicKey?: string;
};

/** Find existing Sui wallet address from user's linked accounts (API may use snake_case or camelCase). */
export function getSuiAddressFromUser(
  user: {
    linked_accounts?: LinkedAccount[];
    linkedAccounts?: LinkedAccount[];
  } | null
): string | null {
  const wallet = getSuiWalletFromUser(user);
  return wallet?.address ?? null;
}

/** Find Sui wallet address and public key for signing (e.g. create margin manager). */
export function getSuiWalletFromUser(
  user: {
    linked_accounts?: LinkedAccount[];
    linkedAccounts?: LinkedAccount[];
  } | null
): { address: string; publicKey: string | null } | null {
  if (!user) return null;
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  for (const a of accounts) {
    const type = a.type;
    const chain =
      (a as LinkedAccount).chain_type ?? (a as LinkedAccount).chainType;
    if (type === "wallet" && (chain === "sui" || chain === "Sui")) {
      const address = (a as LinkedAccount).address ?? null;
      const publicKey =
        (a as LinkedAccount).publicKey ??
        (a as LinkedAccount).public_key ??
        null;
      if (address) return { address, publicKey };
      return null;
    }
  }
  return null;
}
