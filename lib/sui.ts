/** Find existing Sui wallet address from user's linked accounts (API may use snake_case or camelCase). */
export function getSuiAddressFromUser(user: {
  linked_accounts?: Array<{ type?: string; chain_type?: string; address?: string }>;
  linkedAccounts?: Array<{ type?: string; chainType?: string; address?: string }>;
} | null): string | null {
  if (!user) return null;
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  for (const a of accounts) {
    const type = a.type;
    const chain =
      (a as { chain_type?: string; chainType?: string }).chain_type ??
      (a as { chainType?: string }).chainType;
    if (type === 'wallet' && (chain === 'sui' || chain === 'Sui'))
      return (a as { address?: string }).address ?? null;
  }
  return null;
}
