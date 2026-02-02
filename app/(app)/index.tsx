import { Text } from "@/components/Themed";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useEmbeddedEthereumWallet, usePrivy } from "@privy-io/expo";
import {
  useCreateWallet,
  useSignRawHash,
} from "@privy-io/expo/extended-chains";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { fetchAllSuiBalances } from "../../lib/sui-balance-fetch";
import {
  publicKeyToHex,
  sendViaBackend,
} from "../../lib/sui-transfer-via-backend";

const BALANCE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function truncateAddress(address: string) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Find existing Sui wallet address and public key from user's linked accounts (API may use snake_case or camelCase). */
function getSuiWalletFromUser(
  user: {
    linked_accounts?: Array<{
      type?: string;
      chain_type?: string;
      chainType?: string;
      address?: string;
      public_key?: string;
      publicKey?: string;
    }>;
    linkedAccounts?: Array<{
      type?: string;
      chainType?: string;
      address?: string;
      publicKey?: string;
      public_key?: string;
    }>;
  } | null
): { address: string; publicKey: string | null } | null {
  if (!user) return null;
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  for (const a of accounts) {
    const type = a.type;
    const chain =
      (a as { chain_type?: string; chainType?: string }).chain_type ??
      (a as { chainType?: string }).chainType;
    if (type === "wallet" && (chain === "sui" || chain === "Sui")) {
      const address = (a as { address?: string }).address ?? null;
      const publicKey =
        (a as { publicKey?: string; public_key?: string }).publicKey ??
        (a as { publicKey?: string; public_key?: string }).public_key ??
        null;
      if (address) return { address, publicKey };
      return null;
    }
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

  // Send
  const [selectedCoinType, setSelectedCoinType] =
    useState<string>("0x2::sui::SUI");
  const [amount, setAmount] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [amountExceedsBalance, setAmountExceedsBalance] = useState(false);
  const [tokenPickerVisible, setTokenPickerVisible] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [allBalances, setAllBalances] = useState<
    Array<{
      coinType: string;
      totalBalance: string;
      symbol: string;
      formatted: string;
      decimals: number;
    }>
  >([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const { signRawHash } = useSignRawHash();

  const refetchBalances = useCallback(() => {
    if (!suiAddress) return;
    setBalanceError(null);
    setBalanceLoading(true);
    fetchAllSuiBalances(suiAddress)
      .then(setAllBalances)
      .catch((err) => {
        setBalanceError(
          err instanceof Error ? err.message : "Failed to load balances"
        );
        setAllBalances([]);
      })
      .finally(() => setBalanceLoading(false));
  }, [suiAddress]);

  // Initial fetch when address is set
  useEffect(() => {
    if (!suiAddress) {
      setAllBalances([]);
      setBalanceError(null);
      return;
    }
    refetchBalances();
  }, [suiAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 5 min
  useEffect(() => {
    if (!suiAddress) return;
    const id = setInterval(refetchBalances, BALANCE_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [suiAddress, refetchBalances]);

  // Refresh when screen gains focus (e.g. tab switch back to Home)
  useFocusEffect(
    useCallback(() => {
      if (suiAddress) refetchBalances();
    }, [suiAddress, refetchBalances])
  );

  // Refresh when app comes to foreground
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (
          appState.current.match(/inactive|background/) &&
          nextState === "active" &&
          suiAddress
        ) {
          refetchBalances();
        }
        appState.current = nextState;
      }
    );
    return () => sub.remove();
  }, [suiAddress, refetchBalances]);

  // Keep selected coin in sync with balances; default to first balance
  useEffect(() => {
    if (allBalances.length === 0) return;
    const found = allBalances.some((b) => b.coinType === selectedCoinType);
    if (!found) {
      setSelectedCoinType(allBalances[0].coinType);
    }
  }, [allBalances]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedBalance = allBalances.find(
    (b) => b.coinType === selectedCoinType
  );
  const selectedSymbol = selectedBalance?.symbol ?? "SUI";
  const selectedDecimals = selectedBalance?.decimals ?? 9;
  const selectedTotalRaw = selectedBalance?.totalBalance ?? "0";

  const validateAmount = useCallback(
    (amountStr: string) => {
      const num = parseFloat(amountStr);
      if (amountStr.trim() === "" || isNaN(num) || num <= 0) {
        setAmountExceedsBalance(false);
        return;
      }
      const amountRaw = BigInt(
        Math.round(num * Math.pow(10, selectedDecimals))
      );
      if (amountRaw > BigInt(selectedTotalRaw)) {
        setAmountExceedsBalance(true);
        Alert.alert(
          "Amount exceeds balance",
          `You don't have enough ${selectedSymbol}. Max: ${
            selectedBalance?.formatted ?? "0"
          } ${selectedSymbol}.`
        );
      } else {
        setAmountExceedsBalance(false);
      }
    },
    [
      selectedDecimals,
      selectedTotalRaw,
      selectedSymbol,
      selectedBalance?.formatted,
    ]
  );

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

  // Sui: get existing or create, then show address and public key (needed for sending)
  useEffect(() => {
    let cancelled = false;
    setSuiError(null);

    const run = async () => {
      const existing = getSuiWalletFromUser(user);
      if (existing) {
        if (!cancelled) {
          setSuiAddress(existing.address);
          if (existing.publicKey) setSuiWalletPublicKey(existing.publicKey);
          setSuiLoading(false);
        }
        // If linked account has no public_key, fetch wallet via create to get it (idempotent for existing wallet)
        if (existing.publicKey) return;
        try {
          const { wallet } = await createSuiWallet({ chainType: "sui" });
          if (!cancelled && wallet?.address) {
            const pk =
              (wallet as { publicKey?: string; public_key?: string })
                ?.publicKey ??
              (wallet as { publicKey?: string; public_key?: string })
                ?.public_key;
            if (pk) setSuiWalletPublicKey(pk);
          }
        } catch {
          // Non-fatal: address is set, only send will need public key
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

  const handleSend = useCallback(async () => {
    if (!suiAddress?.trim()) {
      setSendError("No Sui wallet");
      return;
    }
    const recipient = destinationAddress.trim();
    if (!recipient) {
      setSendError("Enter destination address");
      return;
    }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setSendError("Enter a valid amount");
      return;
    }
    if (amountExceedsBalance) {
      setSendError("Amount exceeds your balance");
      return;
    }
    const amountRaw = BigInt(
      Math.round(amountNum * Math.pow(10, selectedDecimals))
    );
    if (amountRaw > BigInt(selectedTotalRaw)) {
      setSendError("Amount exceeds your balance");
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
      // On native we use the backend (no @mysten/sui in app). On web we use the SDK directly.
      if (Platform.OS !== "web") {
        const apiUrl =
          process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001";
        const publicKeyHex = publicKeyToHex(publicKeyRaw);
        const { digest } = await sendViaBackend({
          apiUrl,
          sender: suiAddress,
          recipient,
          coinType: selectedCoinType,
          amountMist: String(amountRaw),
          signRawHash,
          publicKeyHex,
          network: "mainnet",
        });
        setSendSuccess(`Sent! Digest: ${digest}`);
        setDestinationAddress("");
        setAmount("");
        setAmountExceedsBalance(false);
        fetchAllSuiBalances(suiAddress)
          .then(setAllBalances)
          .catch(() => {});
      } else {
        const SuiTransfer = await import("../../lib/sui-transfer");
        const client = SuiTransfer.getSuiClient("mainnet");
        const tx = await SuiTransfer.buildTransferAmountTx(
          client,
          suiAddress,
          recipient,
          selectedCoinType,
          amountRaw
        );
        const txBytes = await tx.build({ client });
        const publicKeyBytes =
          typeof publicKeyRaw === "string"
            ? SuiTransfer.decodePublicKeyToRawBytes(publicKeyRaw)
            : publicKeyRaw;
        const { digest } = await SuiTransfer.signAndExecuteWithPrivy(
          client,
          txBytes,
          signRawHash,
          suiAddress,
          publicKeyBytes
        );
        setSendSuccess(`Sent! Digest: ${digest}`);
        setDestinationAddress("");
        setAmount("");
        setAmountExceedsBalance(false);
        fetchAllSuiBalances(suiAddress)
          .then(setAllBalances)
          .catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      setSendError(
        msg.includes("prototype") || msg.includes("undefined")
          ? "Send not available on app. Use web."
          : msg
      );
    } finally {
      setSendLoading(false);
    }
  }, [
    suiAddress,
    selectedCoinType,
    selectedDecimals,
    selectedTotalRaw,
    amount,
    amountExceedsBalance,
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
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <Text style={styles.cardLabel}>Balances</Text>
                  <Pressable
                    onPress={refetchBalances}
                    disabled={balanceLoading}
                    style={({ pressed }) => ({
                      padding: 6,
                      opacity: balanceLoading ? 0.6 : pressed ? 0.8 : 1,
                    })}
                    hitSlop={8}
                  >
                    <FontAwesome name="refresh" size={18} color={colors.tint} />
                  </Pressable>
                </View>
                {balanceLoading ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.tint}
                    style={{ marginTop: 4 }}
                  />
                ) : balanceError ? (
                  <Text style={styles.error}>{balanceError}</Text>
                ) : allBalances.length > 0 ? (
                  allBalances.map((b) => (
                    <View
                      key={b.coinType}
                      style={{ flexDirection: "row", marginTop: 4, gap: 8 }}
                    >
                      <Text style={styles.address}>
                        {b.formatted} {b.symbol}
                      </Text>
                    </View>
                  ))
                ) : null}
              </View>
            )}
          </Pressable>
        ) : (
          <Text style={styles.muted}>No Sui wallet yet</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Send</Text>

        <Text style={[styles.inputLabel, { color: colors.text }]}>Token</Text>
        <Pressable
          onPress={() => setTokenPickerVisible(true)}
          style={[
            styles.input,
            styles.dropdown,
            {
              color: colors.text,
              borderColor: colors.tabIconDefault,
            },
          ]}
        >
          <Text style={{ fontSize: 14 }}>
            {selectedSymbol}
            {selectedBalance != null
              ? ` (${selectedBalance.formatted} available)`
              : " — No balance"}
          </Text>
          <FontAwesome
            name="chevron-down"
            size={14}
            color={colors.tabIconDefault}
          />
        </Pressable>

        <Modal
          visible={tokenPickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setTokenPickerVisible(false)}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => setTokenPickerVisible(false)}
          >
            <View
              style={[
                styles.modalContent,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.tabIconDefault,
                },
              ]}
              onStartShouldSetResponder={() => true}
            >
              <Text style={[styles.inputLabel, { color: colors.text }]}>
                Select token
              </Text>
              <ScrollView style={{ maxHeight: 240 }}>
                {allBalances.length === 0 ? (
                  <Text style={[styles.muted, { paddingVertical: 12 }]}>
                    No tokens
                  </Text>
                ) : (
                  allBalances.map((b) => (
                    <Pressable
                      key={b.coinType}
                      onPress={() => {
                        setSelectedCoinType(b.coinType);
                        setTokenPickerVisible(false);
                        setAmountExceedsBalance(false);
                      }}
                      style={({ pressed }) => [
                        styles.pickerItem,
                        {
                          backgroundColor:
                            b.coinType === selectedCoinType
                              ? colors.tabIconDefault + "30"
                              : "transparent",
                          opacity: pressed ? 0.8 : 1,
                        },
                      ]}
                    >
                      <Text style={{ fontSize: 14, color: colors.text }}>
                        {b.symbol} — {b.formatted} available
                      </Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>

        <Text style={[styles.inputLabel, { color: colors.text }]}>Amount</Text>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.text,
              borderColor: amountExceedsBalance
                ? "#c00"
                : colors.tabIconDefault,
            },
          ]}
          placeholder={`0.00 ${selectedSymbol}`}
          placeholderTextColor={colors.tabIconDefault}
          value={amount}
          onChangeText={(t) => {
            setAmount(t);
            setSendError(null);
            setSendSuccess(null);
            validateAmount(t);
          }}
          keyboardType="decimal-pad"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {amountExceedsBalance && (
          <Text style={styles.error}>Amount exceeds your balance</Text>
        )}

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
          onPress={handleSend}
          disabled={
            sendLoading ||
            !suiAddress ||
            amountExceedsBalance ||
            !amount.trim() ||
            parseFloat(amount) <= 0
          }
          style={({ pressed }) => [
            styles.primaryButton,
            {
              backgroundColor: colors.tint,
              opacity:
                sendLoading ||
                !suiAddress ||
                amountExceedsBalance ||
                !amount.trim() ||
                parseFloat(amount) <= 0
                  ? 0.6
                  : pressed
                  ? 0.8
                  : 1,
            },
          ]}
        >
          {sendLoading ? (
            <ActivityIndicator size="small" color={colors.background} />
          ) : (
            <Text
              style={[styles.primaryButtonText, { color: colors.background }]}
            >
              Send
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
  dropdown: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 24,
  },
  modalContent: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    maxHeight: 320,
  },
  pickerItem: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 4,
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
