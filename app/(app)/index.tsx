import { Text } from "@/components/Themed";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { usePrivy, useEmbeddedEthereumWallet } from "@privy-io/expo";
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
import { NETWORKS, useNetwork } from "@/lib/network";
import { fetchAllBaseSepoliaBalances } from "@/lib/base-balance-fetch";
import { fetchAllSuiBalances } from "../../lib/sui-balance-fetch";
import {
  publicKeyToHex,
  sendViaBackend,
} from "../../lib/sui-transfer-via-backend";

const BALANCE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

type LinkedAccount = {
  type?: string;
  chain_type?: string;
  chainType?: string;
  address?: string;
  public_key?: string;
  publicKey?: string;
};

function truncateAddress(address: string) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Find existing Sui wallet address and public key from user's linked accounts (API may use snake_case or camelCase). */
function getSuiWalletFromUser(
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

/** Try to find an EVM-style wallet (e.g. Base / Ethereum) from Privy linked accounts. */
function getEvmWalletFromUser(
  user: {
    linked_accounts?: LinkedAccount[];
    linkedAccounts?: LinkedAccount[];
  } | null
): { address: string } | null {
  if (!user) return null;
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  for (const a of accounts) {
    const type = a.type;
    const chainRaw =
      (a as LinkedAccount).chain_type ?? (a as LinkedAccount).chainType;
    const chain = chainRaw?.toLowerCase();
    if (!type || type !== "wallet" || !chain) continue;
    // Heuristic: any non-Sui wallet with an EVM-style chain id (e.g. eip155:84532) or "ethereum".
    const isSui = chain === "sui" || chain === "sui-mainnet";
    const isEvmLike =
      chain.includes("eip155:") ||
      chain === "ethereum" ||
      chain.startsWith("base") ||
      chain.startsWith("optimism") ||
      chain.startsWith("arbitrum");
    if (!isSui && isEvmLike) {
      const address = (a as LinkedAccount).address ?? null;
      if (address) return { address };
    }
  }
  return null;
}

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const { user, logout } = usePrivy();
  const { wallets: embeddedEthWallets } = useEmbeddedEthereumWallet();
  const { createWallet: createSuiWallet } = useCreateWallet();

  const { currentNetwork, setCurrentNetworkId } = useNetwork();

  // Ethereum wallet: re-add when needed — useEmbeddedEthereumWallet(), state: address, loading, createError, and a useEffect that creates/fetches wallet when wallets.length changes (see git history for full snippet).

  const [networkDrawerVisible, setNetworkDrawerVisible] = useState(false);

  // Sui wallet state
  const [suiAddress, setSuiAddress] = useState<string | null>(null);
  const [suiWalletPublicKey, setSuiWalletPublicKey] = useState<
    string | Uint8Array | null
  >(null);
  const [suiLoading, setSuiLoading] = useState(true);
  const [suiError, setSuiError] = useState<string | null>(null);

  // EVM / Base-style wallet (read-only for now; used when switching to non-Sui networks).
  const [evmAddress, setEvmAddress] = useState<string | null>(null);

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
  const [baseBalances, setBaseBalances] = useState<
    Array<{
      tokenAddress: string | null;
      rawBalance: string;
      symbol: string;
      formatted: string;
      decimals: number;
    }>
  >([]);
  const [baseBalanceLoading, setBaseBalanceLoading] = useState(false);
  const [baseBalanceError, setBaseBalanceError] = useState<string | null>(null);
  const [selectedBaseToken, setSelectedBaseToken] = useState<string | null>(
    null
  );
  const [baseAmount, setBaseAmount] = useState("");
  const [baseDestination, setBaseDestination] = useState("");
  const [baseAmountExceedsBalance, setBaseAmountExceedsBalance] =
    useState(false);
  const [baseSendLoading, setBaseSendLoading] = useState(false);
  const [baseSendError, setBaseSendError] = useState<string | null>(null);
  const [baseSendSuccess, setBaseSendSuccess] = useState<string | null>(null);
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

  const refetchBaseBalances = useCallback(() => {
    if (!evmAddress || currentNetwork.id !== "base-sepolia") {
      setBaseBalances([]);
      setBaseBalanceError(null);
      setBaseBalanceLoading(false);
      return;
    }
    setBaseBalanceError(null);
    setBaseBalanceLoading(true);
    fetchAllBaseSepoliaBalances(evmAddress)
      .then(setBaseBalances)
      .catch((err) => {
        setBaseBalanceError(
          err instanceof Error ? err.message : "Failed to load balances"
        );
        setBaseBalances([]);
      })
      .finally(() => setBaseBalanceLoading(false));
  }, [evmAddress, currentNetwork.id]);

  // Initial fetch when Sui address is set
  useEffect(() => {
    if (!suiAddress) {
      setAllBalances([]);
      setBalanceError(null);
      return;
    }
    refetchBalances();
  }, [suiAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial fetch when EVM/Base address is set and network is Base Sepolia
  useEffect(() => {
    if (!evmAddress || currentNetwork.id !== "base-sepolia") {
      setBaseBalances([]);
      setBaseBalanceError(null);
      setSelectedBaseToken(null);
      return;
    }
    refetchBaseBalances();
  }, [evmAddress, currentNetwork.id, refetchBaseBalances]);

  // Keep selected Base token in sync with balances; default to first balance
  useEffect(() => {
    if (baseBalances.length === 0) {
      if (selectedBaseToken !== null) setSelectedBaseToken(null);
      return;
    }
    const exists = baseBalances.some(
      (b) => (b.tokenAddress ?? "native") === selectedBaseToken
    );
    if (!exists) {
      const first = baseBalances[0];
      setSelectedBaseToken(first.tokenAddress ?? "native");
    }
  }, [baseBalances, selectedBaseToken]);

  // Auto-refresh every 5 min
  useEffect(() => {
    if (!suiAddress) return;
    const id = setInterval(refetchBalances, BALANCE_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [suiAddress, refetchBalances]);

  // Auto-refresh Base balances every 5 min when on Base Sepolia
  useEffect(() => {
    if (!evmAddress || currentNetwork.id !== "base-sepolia") return;
    const id = setInterval(refetchBaseBalances, BALANCE_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [evmAddress, currentNetwork.id, refetchBaseBalances]);

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

  const copyEvmAddress = useCallback(() => {
    if (!evmAddress) return;
    Clipboard.setString(evmAddress);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2000);
  }, [evmAddress]);

  // Use the first embedded Ethereum wallet for Base Sepolia sends.
  const embeddedEthWallet = embeddedEthWallets?.[0] ?? null;

  const validateBaseAmount = useCallback(
    (amountStr: string) => {
      const num = parseFloat(amountStr);
      if (
        amountStr.trim() === "" ||
        isNaN(num) ||
        num <= 0 ||
        !selectedBaseToken
      ) {
        setBaseAmountExceedsBalance(false);
        return;
      }
      const token = baseBalances.find(
        (b) => (b.tokenAddress ?? "native") === selectedBaseToken
      );
      if (!token) {
        setBaseAmountExceedsBalance(false);
        return;
      }
      const decimals = token.decimals;
      const rawBalance = token.rawBalance;
      const amountRaw = BigInt(
        Math.round(num * Math.pow(10, decimals ?? 18))
      );
      if (amountRaw > BigInt(rawBalance)) {
        setBaseAmountExceedsBalance(true);
        Alert.alert(
          "Amount exceeds balance",
          `You don't have enough ${token.symbol}. Max: ${token.formatted} ${token.symbol}.`
        );
      } else {
        setBaseAmountExceedsBalance(false);
      }
    },
    [baseBalances, selectedBaseToken]
  );

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

  // EVM / Base-style address – mirror Sui flow by using the embedded Ethereum wallet
  // as the single source of truth for the Base account.
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!embeddedEthWallet) {
        if (!cancelled) setEvmAddress(null);
        return;
      }
      try {
        const provider = await (embeddedEthWallet as any).getProvider();
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        if (!cancelled) {
          setEvmAddress(accounts?.[0] ?? null);
        }
      } catch {
        if (!cancelled) setEvmAddress(null);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [embeddedEthWallet]);

  const handleLogout = useCallback(() => {
    logout();
  }, [logout]);

  const handleSendBase = useCallback(async () => {
    if (!evmAddress?.trim()) {
      setBaseSendError("No Base wallet address");
      return;
    }
    if (!embeddedEthWallet) {
      setBaseSendError("No Privy EVM wallet available for sending.");
      return;
    }
    let recipient = baseDestination.trim();
    if (!recipient) {
      setBaseSendError("Enter destination address");
      return;
    }
    if (!recipient.startsWith("0x")) {
      recipient = "0x" + recipient;
    }
    const amountNum = parseFloat(baseAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setBaseSendError("Enter a valid amount");
      return;
    }
    if (!selectedBaseToken) {
      setBaseSendError("Select a token");
      return;
    }
    const token = baseBalances.find(
      (b) => (b.tokenAddress ?? "native") === selectedBaseToken
    );
    if (!token) {
      setBaseSendError("Selected token not found");
      return;
    }
    const decimals = token.decimals;
    const rawBalance = token.rawBalance;
    const amountRaw = BigInt(
      Math.round(amountNum * Math.pow(10, decimals ?? 18))
    );
    if (amountRaw > BigInt(rawBalance)) {
      setBaseSendError("Amount exceeds your balance");
      return;
    }

    setBaseSendError(null);
    setBaseSendSuccess(null);
    setBaseSendLoading(true);
    try {
      const provider = await (embeddedEthWallet as any).getProvider();

      // Ensure embedded wallet is on Base Sepolia before sending.
      try {
        const currentChainId = (await provider.request({
          method: "eth_chainId",
        })) as string;

        // Base Sepolia: chainId 84532 (0x14a34)
        if (currentChainId !== "0x14a34") {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x14a34" }],
          });
        }
      } catch (switchErr) {
        throw new Error(
          "Failed to switch embedded wallet to Base Sepolia. Make sure Base Sepolia is enabled for your Privy app."
        );
      }

      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const from = accounts?.[0];
      if (!from) {
        throw new Error("No account found in embedded Ethereum wallet");
      }

      // Base Sepolia chainId (84532). Other platforms (Swift, Android, Flutter) pass chainId for
      // non-mainnet so the wallet knows which chain to use when populating gas. RN doc omits it.
      const chainIdHex = "0x14a34";

      let txHash: unknown;

      if (token.tokenAddress === null) {
        const valueHex = "0x" + amountRaw.toString(16);
        const tx = {
          from,
          to: recipient,
          value: valueHex,
          chainId: chainIdHex,
          gasLimit: "0x5208", // 21000
        };
        console.log("[Base send] Native ETH tx params", tx);
        txHash = await provider.request({
          method: "eth_sendTransaction",
          params: [tx],
        });
      } else {
        const selector = "0xa9059cbb";
        const addr = recipient.toLowerCase().replace(/^0x/, "");
        const paddedAddress = addr.padStart(64, "0");
        const valueHex = amountRaw.toString(16);
        const paddedValue = valueHex.padStart(64, "0");
        const data = selector + paddedAddress + paddedValue;

        const tx = {
          from,
          to: token.tokenAddress,
          value: "0x0",
          data,
          chainId: chainIdHex,
          gasLimit: "0x186A0", // 100000
        };
        console.log("[Base send] ERC20 tx params", tx);
        txHash = await provider.request({
          method: "eth_sendTransaction",
          params: [tx],
        });
      }

      setBaseSendSuccess(
        `Transaction sent on Base Sepolia. Tx hash: ${String(txHash)}`
      );
      setBaseAmount("");
      setBaseDestination("");
      setBaseAmountExceedsBalance(false);
      refetchBaseBalances();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      setBaseSendError(msg);
    } finally {
      setBaseSendLoading(false);
    }
  }, [
    evmAddress,
    embeddedEthWallet,
    baseDestination,
    baseAmount,
    selectedBaseToken,
    baseBalances,
    refetchBaseBalances,
  ]);

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
        setSendSuccess(`Transaction sent. Txn hash: ${digest}`);
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
        setSendSuccess(`Transaction sent. Txn hash: ${digest}`);
        setDestinationAddress("");
        setAmount("");
        setAmountExceedsBalance(false);
        fetchAllSuiBalances(suiAddress)
          .then(setAllBalances)
          .catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      // Only show "use web" when on web and the SDK crashed (prototype). On native, show the real error (e.g. backend unreachable).
      const useWebMessage =
        Platform.OS === "web" &&
        (msg.includes("prototype") || msg.includes("undefined"));
      setSendError(useWebMessage ? "Send not available on app. Use web." : msg);
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
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>Home</Text>
          <Text style={styles.subtitle}>
            {user?.email?.address ?? user?.google?.email ?? "Signed in"}
          </Text>
        </View>
        <Pressable
          onPress={() => setNetworkDrawerVisible(true)}
          style={({ pressed }) => [
            styles.networkBadge,
            {
              borderColor: currentNetwork.accentColor,
              backgroundColor:
                colorScheme === "dark"
                  ? "rgba(15,23,42,0.9)"
                  : "rgba(248,250,252,0.95)",
              opacity: pressed ? 0.8 : 1,
            },
          ]}
          hitSlop={8}
        >
          <View
            style={[
              styles.networkDot,
              { backgroundColor: currentNetwork.accentColor },
            ]}
          />
          <Text style={styles.networkText}>{currentNetwork.shortLabel}</Text>
          <FontAwesome
            name="chevron-down"
            size={12}
            color={colors.text}
            style={{ marginLeft: 4 }}
          />
        </Pressable>
      </View>

      {/* Network drawer – only on Home screen */}
      <Modal
        visible={networkDrawerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setNetworkDrawerVisible(false)}
      >
        <Pressable
          style={styles.drawerOverlay}
          onPress={() => setNetworkDrawerVisible(false)}
        >
          <View
            style={[
              styles.drawerContent,
              {
                backgroundColor: colors.background,
                borderColor: colors.tabIconDefault,
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.drawerTitle, { color: colors.text }]}>
              Network
            </Text>
            <Text style={[styles.drawerSubtitle, { color: colors.text }]}>
              Margin trading is available on Sui only. Other networks are
              wallet-only for now.
            </Text>
            {NETWORKS.map((net) => {
              const isActive = net.id === currentNetwork.id;
              return (
                <Pressable
                  key={net.id}
                  onPress={() => {
                    setCurrentNetworkId(net.id);
                    setNetworkDrawerVisible(false);
                  }}
                  style={({ pressed }) => [
                    styles.drawerItem,
                    {
                      borderColor: isActive
                        ? net.accentColor
                        : colors.tabIconDefault,
                      backgroundColor: isActive
                        ? net.accentColor + "1A"
                        : "transparent",
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <View style={styles.drawerItemHeader}>
                    <View style={styles.drawerItemTitleRow}>
                      <View
                        style={[
                          styles.networkDot,
                          { backgroundColor: net.accentColor },
                        ]}
                      />
                      <Text
                        style={[
                          styles.drawerItemTitle,
                          { color: colors.text },
                        ]}
                      >
                        {net.label}
                      </Text>
                    </View>
                    {isActive && (
                      <Text
                        style={[
                          styles.drawerActivePill,
                          {
                            borderColor: net.accentColor,
                            color: net.accentColor,
                          },
                        ]}
                      >
                        Active
                      </Text>
                    )}
                  </View>
                  <Text
                    style={[
                      styles.drawerItemDescription,
                      { color: colors.text },
                    ]}
                  >
                    {net.description}
                  </Text>
                  {!net.capabilities.showMarginTab && (
                    <Text style={styles.drawerBadge}>
                      Margin trading not available
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      {currentNetwork.capabilities.showEvmWallet && (
        <>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>
              {currentNetwork.label} wallet (Privy)
            </Text>
            {evmAddress ? (
              <Pressable
                onPress={copyEvmAddress}
                style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}
              >
                <Text style={styles.address} selectable>
                  {evmAddress}
                </Text>
                <Text style={styles.addressShort}>
                  {truncateAddress(evmAddress)}
                </Text>
                {copiedAddress && (
                  <Text
                    style={[styles.muted, { color: "#22c55e", marginTop: 8 }]}
                  >
                    Copied!
                  </Text>
                )}
                <Text style={styles.muted}>
                  This network is wallet-only. Margin trading and deep liquidity
                  are available on Sui.
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.muted}>
                No {currentNetwork.label} wallet linked yet. You can add one in
                your Privy account.
              </Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>
              {currentNetwork.label} balances
            </Text>
            {evmAddress ? (
              <>
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
                    onPress={refetchBaseBalances}
                    disabled={baseBalanceLoading}
                    style={({ pressed }) => ({
                      padding: 6,
                      opacity: baseBalanceLoading ? 0.6 : pressed ? 0.8 : 1,
                    })}
                    hitSlop={8}
                  >
                    <FontAwesome
                      name="refresh"
                      size={18}
                      color={colors.tint}
                    />
                  </Pressable>
                </View>
                {baseBalanceLoading ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.tint}
                    style={{ marginTop: 4 }}
                  />
                ) : baseBalanceError ? (
                  <Text style={styles.error}>{baseBalanceError}</Text>
                ) : baseBalances.length > 0 ? (
                  baseBalances.map((b) => (
                    <View
                      key={b.tokenAddress ?? "native"}
                      style={{
                        flexDirection: "row",
                        marginTop: 4,
                        gap: 8,
                      }}
                    >
                      <Text style={styles.address}>
                        {b.formatted} {b.symbol}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.muted}>No tokens</Text>
                )}
              </>
            ) : (
              <Text style={styles.muted}>
                No {currentNetwork.label} wallet linked yet. You can add one in
                your Privy account.
              </Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>
              Send on {currentNetwork.shortLabel}
            </Text>
            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Token
            </Text>
            <Pressable
              onPress={() => {
                // Simple picker: cycle through tokens; could be replaced by a modal list later.
                if (baseBalances.length === 0) return;
                if (!selectedBaseToken) {
                  setSelectedBaseToken(
                    baseBalances[0].tokenAddress ?? "native"
                  );
                  return;
                }
                const idx = baseBalances.findIndex(
                  (b) => (b.tokenAddress ?? "native") === selectedBaseToken
                );
                const next =
                  baseBalances[(idx + 1) % baseBalances.length] ??
                  baseBalances[0];
                setSelectedBaseToken(next.tokenAddress ?? "native");
                setBaseAmountExceedsBalance(false);
              }}
              style={[
                styles.input,
                styles.dropdown,
                {
                  borderColor: colors.tabIconDefault,
                },
              ]}
            >
              <Text style={{ fontSize: 14, color: colors.text }}>
                {(() => {
                  if (baseBalances.length === 0) return "No tokens";
                  const token = baseBalances.find(
                    (b) => (b.tokenAddress ?? "native") === selectedBaseToken
                  );
                  const active = token ?? baseBalances[0];
                  return `${active.symbol} (${active.formatted} available)`;
                })()}
              </Text>
              <FontAwesome
                name="chevron-down"
                size={14}
                color={colors.tabIconDefault}
              />
            </Pressable>

            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Amount
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.text,
                  borderColor: baseAmountExceedsBalance
                    ? "#c00"
                    : colors.tabIconDefault,
                },
              ]}
              placeholder="0.00"
              placeholderTextColor={colors.tabIconDefault}
              value={baseAmount}
              onChangeText={(t) => {
                setBaseAmount(t);
                setBaseSendError(null);
                setBaseSendSuccess(null);
                validateBaseAmount(t);
              }}
              keyboardType="decimal-pad"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {baseAmountExceedsBalance && (
              <Text style={styles.error}>Amount exceeds your balance</Text>
            )}

            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Destination address
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.text,
                  borderColor: colors.tabIconDefault,
                },
              ]}
              placeholder="0x…"
              placeholderTextColor={colors.tabIconDefault}
              value={baseDestination}
              onChangeText={(t) => {
                setBaseDestination(t);
                setBaseSendError(null);
                setBaseSendSuccess(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {baseSendError ? (
              <Text style={styles.error}>{baseSendError}</Text>
            ) : null}
            {baseSendSuccess ? (
              <Text style={[styles.muted, { color: "#22c55e" }]}>
                {baseSendSuccess}
              </Text>
            ) : null}
            <Pressable
              onPress={handleSendBase}
              disabled={
                baseSendLoading ||
                !evmAddress ||
                !embeddedEthWallet ||
                baseAmountExceedsBalance ||
                !baseAmount.trim() ||
                parseFloat(baseAmount) <= 0 ||
                !baseDestination.trim() ||
                !selectedBaseToken
              }
              style={[
                styles.primaryButton,
                {
                  backgroundColor: colors.tint,
                  opacity:
                    baseSendLoading ||
                    !evmAddress ||
                    !embeddedEthWallet ||
                    baseAmountExceedsBalance ||
                    !baseAmount.trim() ||
                    parseFloat(baseAmount) <= 0 ||
                    !baseDestination.trim() ||
                    !selectedBaseToken
                      ? 0.6
                      : 1,
                  marginTop: 8,
                },
              ]}
            >
              {baseSendLoading ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text
                  style={[
                    styles.primaryButtonText,
                    { color: colors.background },
                  ]}
                >
                  Send
                </Text>
              )}
            </Pressable>
          </View>
        </>
      )}

      {currentNetwork.capabilities.showSuiWallet && (
        <>
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
                  <Text
                    style={[styles.muted, { color: "#22c55e", marginTop: 8 }]}
                  >
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
                        <FontAwesome
                          name="refresh"
                          size={18}
                          color={colors.tint}
                        />
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
                          style={{
                            flexDirection: "row",
                            marginTop: 4,
                            gap: 8,
                          }}
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

            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Token
            </Text>
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

            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Amount
            </Text>
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
                  style={[
                    styles.primaryButtonText,
                    { color: colors.background },
                  ]}
                >
                  Send
                </Text>
              )}
            </Pressable>
          </View>
        </>
      )}

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
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 24,
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
    marginBottom: 4,
  },
  networkBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  networkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  networkText: {
    fontSize: 12,
    fontWeight: "600",
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
  drawerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  drawerContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  drawerTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 4,
  },
  drawerSubtitle: {
    fontSize: 13,
    opacity: 0.7,
    marginBottom: 16,
  },
  drawerItem: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  drawerItemHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  drawerItemTitleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  drawerItemTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  drawerItemDescription: {
    fontSize: 12,
    opacity: 0.75,
  },
  drawerActivePill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "600",
  },
  drawerBadge: {
    marginTop: 6,
    fontSize: 11,
    color: "#f97316",
    fontWeight: "500",
  },
});
