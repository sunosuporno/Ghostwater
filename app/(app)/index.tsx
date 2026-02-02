import { Text } from "@/components/Themed";
import { useEmbeddedEthereumWallet, usePrivy } from "@privy-io/expo";
import {
  useCreateWallet,
  useSignRawHash,
} from "@privy-io/expo/extended-chains";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Clipboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import {
  buildTransferFullBalanceTx,
  decodePublicKeyToRawBytes,
  getBalance,
  getSuiClient,
  signAndExecuteWithPrivy,
} from "@/lib/sui-transfer";

function truncateAddress(address: string) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Find existing Sui wallet address from user's linked accounts (API may use snake_case or camelCase). */
function getSuiAddressFromUser(
  user: {
    linked_accounts?: Array<{
      type?: string;
      chain_type?: string;
      address?: string;
    }>;
    linkedAccounts?: Array<{
      type?: string;
      chainType?: string;
      address?: string;
    }>;
  } | null
): string | null {
  if (!user) return null;
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  for (const a of accounts) {
    const type = a.type;
    const chain =
      (a as { chain_type?: string; chainType?: string }).chain_type ??
      (a as { chainType?: string }).chainType;
    if (type === "wallet" && (chain === "sui" || chain === "Sui"))
      return (a as { address?: string }).address ?? null;
  }
  return null;
}

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const { user, logout } = usePrivy();
  const { wallets, create } = useEmbeddedEthereumWallet();
  const { createWallet: createSuiWallet } = useCreateWallet();

  // Ethereum wallet state (kept for future use, not shown in UI)
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);

  // Sui wallet state (shown in UI)
  const [suiAddress, setSuiAddress] = useState<string | null>(null);
  const [suiWalletPublicKey, setSuiWalletPublicKey] = useState<
    string | Uint8Array | null
  >(null);
  const [suiLoading, setSuiLoading] = useState(true);
  const [suiError, setSuiError] = useState<string | null>(null);

  // Send full balance
  const [tokenAddress, setTokenAddress] = useState("0x2::sui::SUI");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [suiBalance, setSuiBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const { signRawHash } = useSignRawHash();

  // Fetch SUI balance when wallet address is set
  useEffect(() => {
    if (!suiAddress) {
      setSuiBalance(null);
      setBalanceError(null);
      return;
    }
    let cancelled = false;
    setBalanceLoading(true);
    setBalanceError(null);
    const client = getSuiClient("mainnet");
    getBalance(client, suiAddress, "0x2::sui::SUI")
      .then(({ totalBalance }) => {
        if (cancelled) return;
        // totalBalance is in MIST (1 SUI = 1e9 MIST)
        const mist = BigInt(totalBalance);
        const sui = Number(mist) / 1e9;
        setSuiBalance(
          sui.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 6,
          })
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setBalanceError(
            err instanceof Error ? err.message : "Failed to load balance"
          );
          setSuiBalance(null);
        }
      })
      .finally(() => {
        if (!cancelled) setBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [suiAddress]);

  const copySuiAddress = useCallback(() => {
    if (!suiAddress) return;
    Clipboard.setString(suiAddress);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2000);
  }, [suiAddress]);

  // Ethereum: create / fetch address (code kept, not displayed)
  useEffect(() => {
    let cancelled = false;
    setCreateError(null);

    const run = async () => {
      if (wallets.length > 0) {
        try {
          const provider = await wallets[0].getProvider();
          const accounts = (await provider.request({
            method: "eth_requestAccounts",
          })) as string[];
          if (!cancelled && accounts[0]) setAddress(accounts[0]);
        } catch {
          if (!cancelled) setCreateError("Could not get wallet address");
        }
        if (!cancelled) setLoading(false);
        return;
      }

      try {
        await create({});
      } catch (err) {
        if (!cancelled) {
          setCreateError(
            err instanceof Error ? err.message : "Failed to create wallet"
          );
          setLoading(false);
        }
        return;
      }
      if (!cancelled) setLoading(false);
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [wallets.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sui: get existing or create, then show address
  useEffect(() => {
    let cancelled = false;
    setSuiError(null);

    const run = async () => {
      const existing = getSuiAddressFromUser(user);
      if (existing) {
        if (!cancelled) {
          setSuiAddress(existing);
          setSuiLoading(false);
        }
        return;
      }

      try {
        const { wallet } = await createSuiWallet({ chainType: "sui" });
        if (!cancelled && wallet?.address) {
          setSuiAddress(wallet.address);
          const pk =
            (wallet as { publicKey?: string; public_key?: string })
              ?.publicKey ??
            (wallet as { publicKey?: string; public_key?: string })?.public_key;
          if (pk) setSuiWalletPublicKey(pk);
        }
      } catch (err) {
        if (!cancelled) {
          setSuiError(
            err instanceof Error ? err.message : "Failed to create Sui wallet"
          );
        }
      }
      if (!cancelled) setSuiLoading(false);
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = useCallback(() => {
    logout();
  }, [logout]);

  const handleSendFullBalance = useCallback(async () => {
    if (!suiAddress?.trim()) {
      setSendError("No Sui wallet");
      return;
    }
    const coinType = tokenAddress.trim() || "0x2::sui::SUI";
    const recipient = destinationAddress.trim();
    if (!recipient) {
      setSendError("Enter destination address");
      return;
    }
    const publicKeyRaw = suiWalletPublicKey;
    if (!publicKeyRaw) {
      setSendError(
        "Wallet public key not available. Re-open the app or link the Sui wallet again."
      );
      return;
    }
    setSendError(null);
    setSendSuccess(null);
    setSendLoading(true);
    try {
      const client = getSuiClient("mainnet");
      const tx = await buildTransferFullBalanceTx(
        client,
        suiAddress,
        recipient,
        coinType
      );
      const txBytes = await tx.build({ client });
      const publicKeyBytes =
        typeof publicKeyRaw === "string"
          ? decodePublicKeyToRawBytes(publicKeyRaw)
          : publicKeyRaw;
      const { digest } = await signAndExecuteWithPrivy(
        client,
        txBytes,
        signRawHash,
        suiAddress,
        publicKeyBytes
      );
      setSendSuccess(`Sent! Digest: ${digest}`);
      setDestinationAddress("");
      // Refetch balance after send
      getBalance(client, suiAddress, "0x2::sui::SUI")
        .then(({ totalBalance }) => {
          const mist = BigInt(totalBalance);
          const sui = Number(mist) / 1e9;
          setSuiBalance(
            sui.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })
          );
        })
        .catch(() => {});
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSendLoading(false);
    }
  }, [
    suiAddress,
    tokenAddress,
    destinationAddress,
    suiWalletPublicKey,
    signRawHash,
  ]);

  const showSuiLoading = suiLoading && !suiAddress && !suiError;

  if (showSuiLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={styles.loadingText}>Setting up your Sui wallet...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>Home</Text>
      <Text style={styles.subtitle}>
        {user?.email?.address ?? user?.google?.email ?? "Signed in"}
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Your Sui wallet address</Text>
        {suiError ? (
          <Text style={styles.error}>{suiError}</Text>
        ) : suiAddress ? (
          <Pressable
            onPress={copySuiAddress}
            style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}
          >
            <Text style={styles.address} selectable>
              {suiAddress}
            </Text>
            <Text style={styles.addressShort}>
              {truncateAddress(suiAddress)}
            </Text>
            {copiedAddress && (
              <Text style={[styles.muted, { color: "#22c55e", marginTop: 8 }]}>
                Copied!
              </Text>
            )}
            {suiAddress && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.cardLabel}>Balance (SUI)</Text>
                {balanceLoading ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.tint}
                    style={{ marginTop: 4 }}
                  />
                ) : balanceError ? (
                  <Text style={styles.error}>{balanceError}</Text>
                ) : suiBalance != null ? (
                  <Text style={styles.address}>{suiBalance} SUI</Text>
                ) : null}
              </View>
            )}
          </Pressable>
        ) : (
          <Text style={styles.muted}>No Sui wallet yet</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Send full balance</Text>
        <Text style={[styles.inputLabel, { color: colors.text }]}>
          Token (coin type)
        </Text>
        <TextInput
          style={[
            styles.input,
            { color: colors.text, borderColor: colors.tabIconDefault },
          ]}
          placeholder="0x2::sui::SUI"
          placeholderTextColor={colors.tabIconDefault}
          value={tokenAddress}
          onChangeText={setTokenAddress}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={[styles.inputLabel, { color: colors.text }]}>
          Destination address
        </Text>
        <TextInput
          style={[
            styles.input,
            { color: colors.text, borderColor: colors.tabIconDefault },
          ]}
          placeholder="0x…"
          placeholderTextColor={colors.tabIconDefault}
          value={destinationAddress}
          onChangeText={(t) => {
            setDestinationAddress(t);
            setSendError(null);
            setSendSuccess(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
        {sendSuccess ? (
          <Text style={[styles.muted, { color: "#22c55e" }]}>
            {sendSuccess}
          </Text>
        ) : null}
        <Pressable
          onPress={handleSendFullBalance}
          disabled={sendLoading || !suiAddress}
          style={({ pressed }) => [
            styles.primaryButton,
            {
              backgroundColor: colors.tint,
              opacity: sendLoading || !suiAddress ? 0.6 : pressed ? 0.8 : 1,
            },
          ]}
        >
          {sendLoading ? (
            <ActivityIndicator size="small" color={colors.background} />
          ) : (
            <Text
              style={[styles.primaryButtonText, { color: colors.background }]}
            >
              Send full balance
            </Text>
          )}
        </Pressable>
      </View>

      <Pressable
        onPress={handleLogout}
        style={({ pressed }) => [
          styles.logoutButton,
          {
            backgroundColor: colors.tabIconDefault,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        <Text style={styles.logoutText}>Log out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 48,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    opacity: 0.8,
    marginBottom: 32,
  },
  card: {
    padding: 20,
    borderRadius: 12,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.3)",
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: "600",
    opacity: 0.8,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  address: {
    fontSize: 14,
    fontFamily: "SpaceMono",
    marginBottom: 4,
  },
  addressShort: {
    fontSize: 12,
    opacity: 0.7,
  },
  muted: {
    fontSize: 14,
    opacity: 0.6,
  },
  error: {
    fontSize: 14,
    color: "#c00",
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
    opacity: 0.8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 16,
  },
  primaryButton: {
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  logoutButton: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: "center",
    alignSelf: "center",
  },
  logoutText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
