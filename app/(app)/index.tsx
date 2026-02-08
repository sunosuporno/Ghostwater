import { Text } from "@/components/Themed";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { usePrivy, useEmbeddedEthereumWallet } from "@privy-io/expo";
import {
  useCreateWallet,
  useSignRawHash,
} from "@privy-io/expo/extended-chains";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  AppStateStatus,
  Clipboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";

import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  fetchSubdomainStatus,
  checkLabelAvailable,
  getRegisterWithPreferencesCalldata,
  getSetPreferencesCalldata,
  getRegistrarAddress,
  getRegistrarRevertMessage,
  resolveSubdomainAddress,
  type SubdomainStatus,
} from "@/lib/ens-subdomain-base";
import { getRecipientPreferredTokenAddressAndNetworkId } from "@/lib/preferred-chains-tokens";
import { fetchLifiQuote, fetchLifiStatus, type LifiStatusResponse } from "@/lib/lifi-quote";
import { isBaseMainnet, NETWORKS, useNetwork } from "@/lib/network";
import {
  fetchAllBaseBalances,
  type BaseNetworkId,
} from "@/lib/base-balance-fetch";
import { fetchAllSuiBalances } from "../../lib/sui-balance-fetch";
import {
  publicKeyToHex,
  sendViaBackend,
} from "../../lib/sui-transfer-via-backend";

const BALANCE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** Preferred chain options for subdomain preferences (stored as chain name string). */
const PREFERRED_CHAIN_OPTIONS = ["Base", "Arbitrum", "Sui", "Ethereum"] as const;

/** Preferred token options: symbol or "OTHER" for custom address (stored as symbol or full address string). */
const PREFERRED_TOKEN_OPTIONS = [
  { value: "ETH", label: "ETH (native)" },
  { value: "USDC", label: "USDC" },
  { value: "USDT", label: "USDT" },
  { value: "OTHER", label: "Other (paste address)" },
] as const;

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

function isHexAddress(value: string): boolean {
  const v = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isGhostwaterSubdomain(value: string): boolean {
  return value.trim().toLowerCase().endsWith(".ghostwater.eth");
}

/** Time-based greeting (local time). Morning / afternoon / evening only; no "good night". */
function getTimeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
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
  const { createWallet: createPrivyWallet } = useCreateWallet();

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
  const [baseDestinationInput, setBaseDestinationInput] = useState("");
  const [baseDestinationAddress, setBaseDestinationAddress] = useState<string | null>(null);
  const [resolvedToAddressDisplay, setResolvedToAddressDisplay] = useState<string | null>(null);
  const [resolvedToAddressLoading, setResolvedToAddressLoading] = useState(false);
  const [resolvedToAddressLabel, setResolvedToAddressLabel] = useState<string | null>(null);
  const [baseAmountExceedsBalance, setBaseAmountExceedsBalance] =
    useState(false);
  const [baseSendLoading, setBaseSendLoading] = useState(false);
  const [baseSendError, setBaseSendError] = useState<string | null>(null);
  const [baseSendSuccess, setBaseSendSuccess] = useState<string | null>(null);
  const [baseSendTxHash, setBaseSendTxHash] = useState<string | null>(null);
  const [baseSendIsCrossChain, setBaseSendIsCrossChain] = useState(false);
  const [baseSendLifiStatus, setBaseSendLifiStatus] = useState<LifiStatusResponse | null>(null);
  const [baseTxHashCopied, setBaseTxHashCopied] = useState(false);
  const [baseQrVisible, setBaseQrVisible] = useState(false);
  const [baseSendTokenPickerVisible, setBaseSendTokenPickerVisible] = useState(false);
  const [scannedRecipient, setScannedRecipient] = useState<{
    handle: string | null;
    address: string;
    preferredChain: string | null;
    preferredToken: string | null;
  } | null>(null);
  const { signRawHash } = useSignRawHash();

  // ENS subdomain (Base mainnet only)
  const [subdomainStatus, setSubdomainStatus] = useState<SubdomainStatus | null>(null);
  const [subdomainLoading, setSubdomainLoading] = useState(false);
  const [subdomainError, setSubdomainError] = useState<string | null>(null);
  const [claimLabel, setClaimLabel] = useState("");
  const [claimPreferredChain, setClaimPreferredChain] = useState("");
  const [claimPreferredToken, setClaimPreferredToken] = useState<"ETH" | "USDC" | "USDT" | "OTHER" | "">("");
  const [claimPreferredTokenCustom, setClaimPreferredTokenCustom] = useState("");
  const [claimSuiAddress, setClaimSuiAddress] = useState("");
  const [chainPickerVisible, setChainPickerVisible] = useState(false);
  const [tokenPickerVisibleSubdomain, setTokenPickerVisibleSubdomain] = useState(false);
  const [claimNameAvailable, setClaimNameAvailable] = useState<boolean | null>(null);
  const [claimCheckingName, setClaimCheckingName] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimStep, setClaimStep] = useState<1 | 2 | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const subdomainBlinkAnim = useRef(new Animated.Value(1)).current;

  // Edit preferences (when user already has subdomain)
  const [editPrefsVisible, setEditPrefsVisible] = useState(false);
  const [editPrefsChain, setEditPrefsChain] = useState("");
  const [editPrefsToken, setEditPrefsToken] = useState<"ETH" | "USDC" | "USDT" | "OTHER" | "">("");
  const [editPrefsTokenCustom, setEditPrefsTokenCustom] = useState("");
  const [editPrefsSuiAddress, setEditPrefsSuiAddress] = useState("");
  const [editPrefsLoading, setEditPrefsLoading] = useState(false);
  const [editPrefsError, setEditPrefsError] = useState<string | null>(null);
  const [editChainPickerVisible, setEditChainPickerVisible] = useState(false);
  const [editTokenPickerVisible, setEditTokenPickerVisible] = useState(false);

  const urlParams = useLocalSearchParams<{
    type?: string;
    handle?: string;
    address?: string;
    token?: string;
    chain?: string;
  }>();
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);
  const initialUrlHandledRef = useRef(false);

  const scrollViewRef = useRef<ScrollView>(null);
  const hasScrolledForDeepLinkRef = useRef(false);

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
    const isBase =
      currentNetwork.id === "base-sepolia" ||
      currentNetwork.id === "base-mainnet";
    if (!evmAddress || !isBase) {
      setBaseBalances([]);
      setBaseBalanceError(null);
      setBaseBalanceLoading(false);
      return;
    }
    setBaseBalanceError(null);
    setBaseBalanceLoading(true);
    fetchAllBaseBalances(evmAddress, currentNetwork.id as BaseNetworkId)
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

  // Initial fetch when EVM/Base address is set and network is Base (Sepolia or mainnet)
  useEffect(() => {
    const isBase =
      currentNetwork.id === "base-sepolia" ||
      currentNetwork.id === "base-mainnet";
    if (!evmAddress || !isBase) {
      setBaseBalances([]);
      setBaseBalanceError(null);
      setSelectedBaseToken(null);
      return;
    }
    refetchBaseBalances();
  }, [evmAddress, currentNetwork.id, refetchBaseBalances]);

  const registrarAddress = getRegistrarAddress();
  const refetchSubdomain = useCallback(async () => {
    if (!registrarAddress || !evmAddress || !isBaseMainnet(currentNetwork.id)) {
      setSubdomainStatus(null);
      setSubdomainLoading(false);
      return;
    }
    setSubdomainError(null);
    setSubdomainLoading(true);
    try {
      const status = await fetchSubdomainStatus(registrarAddress, evmAddress as `0x${string}`);
      setSubdomainStatus(status);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = /429|rate limit|over rate limit/i.test(raw) ? "Rate limited – tap to retry" : raw;
      setSubdomainError(message);
      setSubdomainStatus((prev) => (prev?.hasSubdomain ? prev : null));
    } finally {
      setSubdomainLoading(false);
    }
  }, [registrarAddress, evmAddress, currentNetwork.id]);

  useEffect(() => {
    if (!registrarAddress || !evmAddress || !isBaseMainnet(currentNetwork.id)) {
      setSubdomainStatus(null);
      setSubdomainLoading(false);
      return;
    }
    refetchSubdomain();
  }, [registrarAddress, evmAddress, currentNetwork.id, refetchSubdomain]);

  // Blink animation when no subdomain (claim CTA)
  useEffect(() => {
    if (subdomainLoading || !subdomainStatus || subdomainStatus.hasSubdomain) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(subdomainBlinkAnim, { toValue: 0.4, duration: 600, useNativeDriver: true }),
        Animated.timing(subdomainBlinkAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [subdomainLoading, subdomainStatus?.hasSubdomain, subdomainBlinkAnim]);

  // Debounced name availability check
  useEffect(() => {
    const label = claimLabel.trim().toLowerCase();
    if (label.length < 3) {
      setClaimNameAvailable(null);
      return;
    }
    if (!registrarAddress) return;
    const t = setTimeout(async () => {
      setClaimCheckingName(true);
      setClaimNameAvailable(null);
      try {
        const available = await checkLabelAvailable(registrarAddress, label);
        setClaimNameAvailable(available);
      } catch {
        setClaimNameAvailable(null);
      } finally {
        setClaimCheckingName(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [claimLabel, registrarAddress]);

  // Resolve subdomain in send block to show "To address" (EVM or Sui) in readonly field
  useEffect(() => {
    const raw = baseDestinationInput.trim().toLowerCase();
    if (!raw || !isGhostwaterSubdomain(raw)) {
      setResolvedToAddressDisplay(null);
      setResolvedToAddressLabel(null);
      setResolvedToAddressLoading(false);
      return;
    }
    const label = raw.includes(".") ? raw.split(".")[0] : raw;
    if (label.length < 3) {
      setResolvedToAddressDisplay(null);
      setResolvedToAddressLabel(null);
      setResolvedToAddressLoading(false);
      return;
    }
    let cancelled = false;
    setResolvedToAddressLoading(true);
    (async () => {
      try {
        const resolved = await resolveSubdomainAddress(raw);
        if (cancelled) return;
        if (!resolved) {
          setResolvedToAddressDisplay(null);
          setResolvedToAddressLabel(null);
          setResolvedToAddressLoading(false);
          return;
        }
        const registrarAddr = getRegistrarAddress();
        if (!registrarAddr) {
          setResolvedToAddressDisplay(resolved);
          setResolvedToAddressLabel("EVM address");
          setResolvedToAddressLoading(false);
          return;
        }
        const status = await fetchSubdomainStatus(registrarAddr, resolved as `0x${string}`);
        if (cancelled) return;
        const isSui = status.preferredChain?.trim().toLowerCase() === "sui";
        const suiAddr = status.suiAddress?.trim();
        if (isSui) {
          setResolvedToAddressDisplay(suiAddr || "Not set");
          setResolvedToAddressLabel("Sui receive address");
        } else {
          setResolvedToAddressDisplay(resolved);
          setResolvedToAddressLabel("EVM address");
        }
      } catch {
        if (!cancelled) {
          setResolvedToAddressDisplay(null);
          setResolvedToAddressLabel(null);
        }
      } finally {
        if (!cancelled) setResolvedToAddressLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseDestinationInput]);

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

  // Auto-refresh Base balances every 5 min when on Base (Sepolia or mainnet)
  useEffect(() => {
    const isBase =
      currentNetwork.id === "base-sepolia" ||
      currentNetwork.id === "base-mainnet";
    if (!evmAddress || !isBase) return;
    const id = setInterval(refetchBaseBalances, BALANCE_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [evmAddress, currentNetwork.id, refetchBaseBalances]);

  // Poll LI.FI status for cross-chain sends until DONE/FAILED or timeout
  const fromChainIdForStatus = currentNetwork.evmChainId
    ? parseInt(currentNetwork.evmChainId, 16)
    : undefined;
  useEffect(() => {
    if (!baseSendTxHash || !baseSendIsCrossChain) return;

    let notFoundCount = 0;
    const maxNotFound = 10;
    const pollMs = 6000;
    const maxPolls = 50;

    const poll = async () => {
      try {
        const status = await fetchLifiStatus(baseSendTxHash!, fromChainIdForStatus);
        setBaseSendLifiStatus(status);
        if (status.status === "NOT_FOUND") {
          notFoundCount += 1;
          if (notFoundCount >= maxNotFound) return true;
        } else {
          notFoundCount = 0;
          if (status.status === "DONE" || status.status === "FAILED") return true;
        }
      } catch {
        // keep polling on network error
      }
      return false;
    };

    let pollCount = 0;
    const id = setInterval(async () => {
      pollCount += 1;
      if (pollCount > maxPolls) {
        clearInterval(id);
        return;
      }
      const done = await poll();
      if (done) clearInterval(id);
    }, pollMs);

    // initial fetch
    poll();

    return () => clearInterval(id);
  }, [baseSendTxHash, baseSendIsCrossChain, fromChainIdForStatus]);

  // Refresh when screen gains focus (e.g. tab switch back to Home)
  useFocusEffect(
    useCallback(() => {
      if (suiAddress) refetchBalances();
      if (isBaseMainnet(currentNetwork.id) && evmAddress && registrarAddress) refetchSubdomain();
    }, [suiAddress, refetchBalances, currentNetwork.id, evmAddress, registrarAddress, refetchSubdomain])
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
    const toCopy = subdomainStatus?.fullName ?? evmAddress;
    Clipboard.setString(toCopy);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2000);
  }, [evmAddress, subdomainStatus?.fullName]);

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
          const { wallet } = await createPrivyWallet({ chainType: "sui" });
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
        const { wallet } = await createPrivyWallet({ chainType: "sui" });
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

  // Ensure an embedded EVM wallet exists (for Base/Ethereum) whenever a user logs in.
  useEffect(() => {
    const ensureEvmWallet = async () => {
      try {
        if (!user?.id) return;
        // If we already have at least one embedded EVM wallet, nothing to do.
        if (embeddedEthWallets && embeddedEthWallets.length > 0) return;
        // @ts-expect-error - createWallet supports ethereum at runtime; SDK types omit it
        await createPrivyWallet({ chainType: "ethereum" });
      } catch {
        // Best-effort only; UI will still show "No Base wallet linked" if this fails.
      }
    };
    ensureEvmWallet();
  }, [user?.id, embeddedEthWallets?.length, createPrivyWallet]);

  // Cold start: when app was closed and opened via QR/link, useLocalSearchParams may not have the URL yet.
  // Linking.getInitialURL() returns the URL that launched the app — handle pay link so we open on Base and set destination.
  useEffect(() => {
    if (initialUrlHandledRef.current) return;
    initialUrlHandledRef.current = true;

    Linking.getInitialURL()
      .then((url) => {
        if (!url || !url.includes("type=pay")) return;
        const q = url.indexOf("?");
        const query = q >= 0 ? url.slice(q + 1) : "";
        const params = new URLSearchParams(query);
        const type = params.get("type");
        const handleParam = params.get("handle") ?? undefined;
        const addressParam = params.get("address") ?? undefined;
        const tokenParam = params.get("token") ?? undefined;
        const chainParam = params.get("chain") ?? undefined;

        if (type !== "pay") return;
        const hasAddress = typeof addressParam === "string" && addressParam.length > 0;
        const hasHandle = typeof handleParam === "string" && handleParam.length > 0;
        if (!hasAddress && !hasHandle) return;

        setCurrentNetworkId("base-mainnet");
        setBaseDestinationInput(handleParam ?? addressParam ?? "");
        setBaseDestinationAddress(hasAddress ? addressParam : null);
        setScannedRecipient({
          handle: handleParam ?? null,
          address: addressParam ?? "",
          preferredChain: chainParam ?? null,
          preferredToken: tokenParam ?? null,
        });
        setDeepLinkHandled(true);
      })
      .catch(() => {});
  }, [setCurrentNetworkId]);

  // Handle deep links when app is already running (or when Expo Router has injected params after cold start).
  useEffect(() => {
    if (deepLinkHandled) return;
    if (!urlParams || urlParams.type !== "pay") return;

    const addressParam = Array.isArray(urlParams.address)
      ? urlParams.address[0]
      : urlParams.address;
    const tokenParam = Array.isArray(urlParams.token)
      ? urlParams.token[0]
      : urlParams.token;
    const handleParam = Array.isArray(urlParams.handle)
      ? urlParams.handle[0]
      : urlParams.handle;
    const chainParam = Array.isArray(urlParams.chain)
      ? urlParams.chain[0]
      : urlParams.chain;

    const hasAddress = typeof addressParam === "string" && addressParam.length > 0;
    const hasHandle = typeof handleParam === "string" && handleParam.length > 0;
    if (!hasAddress && !hasHandle) return;

    setCurrentNetworkId("base-mainnet");
    setBaseDestinationInput(handleParam ?? addressParam ?? "");
    setBaseDestinationAddress(hasAddress ? addressParam : null);
    if (tokenParam && baseBalances.length > 0) {
      const match = baseBalances.find(
        (b) => b.symbol.toUpperCase() === tokenParam.toUpperCase()
      );
      if (match) {
        setSelectedBaseToken(match.tokenAddress ?? "native");
      }
    }
    setScannedRecipient({
      handle: handleParam ?? null,
      address: addressParam ?? "",
      preferredChain: chainParam ?? null,
      preferredToken: tokenParam ?? null,
    });
    setDeepLinkHandled(true);
  }, [
    urlParams,
    deepLinkHandled,
    baseBalances,
    setCurrentNetworkId,
  ]);

  // When we just opened via pay deep link, scroll to the bottom so the send section is in view.
  useEffect(() => {
    if (!deepLinkHandled || hasScrolledForDeepLinkRef.current) return;
    const t = setTimeout(() => {
      hasScrolledForDeepLinkRef.current = true;
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 500);
    return () => clearTimeout(t);
  }, [deepLinkHandled]);

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
    if (baseSendLoading) return;
    if (!evmAddress?.trim()) {
      setBaseSendError("No Base wallet address");
      return;
    }
    if (!embeddedEthWallet) {
      setBaseSendError("No Privy EVM wallet available for sending.");
      return;
    }
    const rawInput = baseDestinationInput.trim();
    if (!rawInput && !baseDestinationAddress) {
      setBaseSendError("Enter destination address");
      return;
    }

    let recipient: string | null = null;
    let isSubdomainReceiver = false;

    // When the user has entered a subdomain, always use subdomain flow (resolve → preferred chain/token/Sui → LI.FI).
    // Otherwise we might use baseDestinationAddress from a deep link and do a plain send to EVM instead of cross-chain to Sui.
    if (rawInput && isGhostwaterSubdomain(rawInput)) {
      const resolved = await resolveSubdomainAddress(rawInput);
      if (!resolved) {
        setBaseSendError("Ghostwater name not found");
        return;
      }
      recipient = resolved;
      isSubdomainReceiver = true;
    } else if (rawInput && isHexAddress(rawInput)) {
      recipient = rawInput;
    } else if (baseDestinationAddress) {
      recipient = baseDestinationAddress;
    } else {
      setBaseSendError("Enter a valid 0x address or Ghostwater name");
      return;
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

    // Branch: subdomain receiver → LI.FI quote then send tx; address → send as usual
    if (isSubdomainReceiver && recipient) {
      setBaseSendError(null);
      setBaseSendSuccess(null);
      setBaseSendTxHash(null);
      setBaseSendLoading(true);
      try {
        const provider = await (embeddedEthWallet as any).getProvider();
        const chainIdHex = currentNetwork.evmChainId;
        if (!chainIdHex) {
          setBaseSendError("Current network is not configured for cross-chain send.");
          return;
        }
        const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        const from = accounts?.[0];
        if (!from) {
          setBaseSendError("No account found in embedded wallet");
          return;
        }
        try {
          const currentChainId = (await provider.request({ method: "eth_chainId" })) as string;
          if (currentChainId !== chainIdHex) {
            await provider.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: chainIdHex }],
            });
          }
        } catch {
          setBaseSendError(`Switch to ${currentNetwork.shortLabel} in your wallet and try again.`);
          return;
        }

        const registrarAddr = getRegistrarAddress();
        let recipientPreferredChain: string | null = null;
        let recipientPreferredToken: string | null = null;
        let recipientSuiAddress: string | null = null;
        if (registrarAddr) {
          try {
            const status = await fetchSubdomainStatus(
              registrarAddr,
              recipient as `0x${string}`
            );
            recipientPreferredChain = status.preferredChain ?? null;
            recipientPreferredToken = status.preferredToken ?? null;
            recipientSuiAddress = status.suiAddress ?? null;
          } catch {
            // keep nulls if fetch fails
          }
        }
        const { favouredTokenAddress, networkId } =
          getRecipientPreferredTokenAddressAndNetworkId(
            recipientPreferredChain,
            recipientPreferredToken
          );
        console.log("[Send Base] Receiver is Ghostwater subdomain:", {
          subdomainName: rawInput,
          tokenAddress: selectedBaseToken,
          amount: baseAmount,
          recipientPreferredChain,
          recipientPreferredToken,
          recipientSuiAddress,
          recipientFavouredTokenAddress: favouredTokenAddress,
          recipientPreferredNetworkId: networkId,
        });

        // Resolve destination native token for LI.FI (EVM uses 0x0...0, Sui uses SUI coin type)
        const toTokenForQuote =
          favouredTokenAddress === "native"
            ? (networkId === 9270000000000000
                ? "0x2::sui::SUI"
                : "0x0000000000000000000000000000000000000000")
            : favouredTokenAddress;

        const fromChainId = currentNetwork.evmChainId
          ? parseInt(currentNetwork.evmChainId, 16)
          : null;
        if (
          fromChainId == null ||
          networkId == null ||
          !toTokenForQuote ||
          !evmAddress
        ) {
          setBaseSendError("Could not build cross-chain route (missing chain or token).");
          return;
        }

        const fromTokenAddress =
          selectedBaseToken === "native"
            ? "0x0000000000000000000000000000000000000000"
            : selectedBaseToken;
        const toChainId =
          typeof networkId === "number"
            ? networkId
            : String(networkId) === "sui"
              ? 9270000000000000
              : parseInt(String(networkId), 10);
        if (Number.isNaN(toChainId)) {
          setBaseSendError("Invalid recipient preferred chain.");
          return;
        }

        const isDestinationSui = toChainId === 9270000000000000;
        const toAddressParam =
          isDestinationSui && recipientSuiAddress?.trim()
            ? recipientSuiAddress.trim()
            : !isDestinationSui
              ? recipient
              : undefined;

        if (isDestinationSui && !toAddressParam) {
          setBaseSendError(
            "Recipient's preferred chain is Sui but they haven't set a Sui receive address. They can add it in their Ghostwater preferences."
          );
          setBaseSendLoading(false);
          return;
        }

        // Same chain + same token → simple direct send (no LI.FI)
        const sameChain = fromChainId === toChainId;
        const sameToken =
          fromTokenAddress === toTokenForQuote ||
          (fromTokenAddress === "0x0000000000000000000000000000000000000000" &&
            toTokenForQuote === "0x0000000000000000000000000000000000000000");
        if (sameChain && sameToken && !isDestinationSui) {
          let txHash: unknown;
          if (selectedBaseToken === "native") {
            const valueHex = "0x" + amountRaw.toString(16);
            txHash = await provider.request({
              method: "eth_sendTransaction",
              params: [{
                from,
                to: recipient,
                value: valueHex,
                chainId: chainIdHex,
                gasLimit: "0x5208",
              }],
            });
          } else {
            const selector = "0xa9059cbb";
            const addr = (recipient as string).toLowerCase().replace(/^0x/, "");
            const paddedAddress = addr.padStart(64, "0");
            const valueHex = amountRaw.toString(16);
            const paddedValue = valueHex.padStart(64, "0");
            const data = selector + paddedAddress + paddedValue;
            txHash = await provider.request({
              method: "eth_sendTransaction",
              params: [{
                from,
                to: selectedBaseToken,
                value: "0x0",
                data,
                chainId: chainIdHex,
                gasLimit: "0x186A0",
              }],
            });
          }
          const hashStr = String(txHash);
          setBaseSendSuccess(
            `Transaction sent on ${currentNetwork.shortLabel}. Tx hash: ${hashStr}`
          );
          setBaseSendTxHash(hashStr);
          setBaseSendIsCrossChain(false);
          setBaseSendLifiStatus(null);
          setBaseAmount("");
          setBaseDestinationInput("");
          setBaseDestinationAddress(null);
          setBaseAmountExceedsBalance(false);
          refetchBaseBalances();
          setBaseSendLoading(false);
          return;
        }

        const quoteResult = (await fetchLifiQuote({
          fromChainId,
          toChainId,
          fromTokenAddress,
          toTokenAddress: toTokenForQuote,
          fromAmount: amountRaw.toString(),
          fromAddress: evmAddress,
          toAddress: toAddressParam ?? recipient,
          slippage: 0.005,
        })) as {
          transactionRequest?: {
            to?: string;
            data?: string;
            value?: string;
            gasLimit?: string;
            gasPrice?: string;
            maxFeePerGas?: string;
            maxPriorityFeePerGas?: string;
            chainId?: number;
          };
          estimate?: { approvalAddress?: string };
        };

        console.log("[Send Base] LI.FI quote result:", quoteResult);

        const txRequest = quoteResult?.transactionRequest;
        if (!txRequest?.to || !txRequest?.data) {
          setBaseSendError("No transaction returned from route. Try a different amount or token.");
          return;
        }

        // Use explicit nonce so approval + bridge run in order and we avoid "nonce too low" on the second tx.
        let nextNonce = parseInt(
          (await provider.request({
            method: "eth_getTransactionCount",
            params: [from, "latest"],
          })) as string,
          16
        );

        // ERC20 approval: when sending a token (not native ETH), LI.FI returns estimate.approvalAddress.
        // We must approve that contract to spend our tokens before the bridge tx (which uses transferFrom).
        const isErc20 = fromTokenAddress !== "0x0000000000000000000000000000000000000000";
        const approvalAddress = quoteResult?.estimate?.approvalAddress;
        if (isErc20 && approvalAddress) {
          const pad64 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
          const amountHex = amountRaw.toString(16);
          const approveData =
            "0x095ea7b3" + pad64(approvalAddress) + pad64(amountHex);
          const approveTxHash = (await provider.request({
            method: "eth_sendTransaction",
            params: [
              {
                from,
                to: fromTokenAddress,
                data: approveData,
                value: "0x0",
                gasLimit: "0xfde8",
                chainId: chainIdHex,
                nonce: "0x" + nextNonce.toString(16),
              },
            ],
          })) as string;
          nextNonce += 1;
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            const receipt = (await provider.request({
              method: "eth_getTransactionReceipt",
              params: [approveTxHash],
            })) as { blockNumber?: string } | null;
            if (receipt?.blockNumber) break;
          }
          // Refresh nonce after approval so bridge tx uses the correct one (avoids "nonce too low").
          nextNonce = parseInt(
            (await provider.request({
              method: "eth_getTransactionCount",
              params: [from, "latest"],
            })) as string,
            16
          );
        }

        const tx: Record<string, string> = {
          from,
          to: txRequest.to,
          data: txRequest.data,
          value: txRequest.value ?? "0x0",
          nonce: "0x" + nextNonce.toString(16),
        };
        if (txRequest.gasLimit) tx.gasLimit = txRequest.gasLimit;
        if (txRequest.gasPrice) tx.gasPrice = txRequest.gasPrice;
        if (txRequest.maxFeePerGas) tx.maxFeePerGas = txRequest.maxFeePerGas;
        if (txRequest.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = txRequest.maxPriorityFeePerGas;
        if (txRequest.chainId != null) tx.chainId = "0x" + Number(txRequest.chainId).toString(16);

        const txHash = await provider.request({
          method: "eth_sendTransaction",
          params: [tx],
        });
        const hashStr = String(txHash);
        setBaseSendSuccess(
          `Cross-chain send submitted on ${currentNetwork.shortLabel}. Tx: ${hashStr}`
        );
        setBaseSendTxHash(hashStr);
        setBaseSendIsCrossChain(true);
        setBaseSendLifiStatus(null);
        setBaseAmount("");
        setBaseDestinationInput("");
        setBaseDestinationAddress(null);
        setBaseAmountExceedsBalance(false);
        refetchBaseBalances();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already known|replacement fee too low|nonce too low/i.test(msg)) {
          setBaseSendError(null);
        } else {
          setBaseSendError(msg);
        }
      } finally {
        setBaseSendLoading(false);
      }
      return;
    }

    setBaseSendError(null);
    setBaseSendSuccess(null);
    setBaseSendTxHash(null);
    setBaseSendLoading(true);
    try {
      const provider = await (embeddedEthWallet as any).getProvider();

      const chainIdHex = currentNetwork.evmChainId;
      if (!chainIdHex) {
        throw new Error("Current network is not configured for EVM sends.");
      }

      // Ensure embedded wallet is on the correct chain (Base Sepolia or Base mainnet) before sending.
      try {
        const currentChainId = (await provider.request({
          method: "eth_chainId",
        })) as string;

        if (currentChainId !== chainIdHex) {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: chainIdHex }],
          });
        }
      } catch (switchErr) {
        throw new Error(
          `Failed to switch embedded wallet to ${currentNetwork.shortLabel}. Make sure this network is enabled for your Privy app.`
        );
      }

      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const from = accounts?.[0];
      if (!from) {
        throw new Error("No account found in embedded Ethereum wallet");
      }

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

      const hashStr = String(txHash);
      setBaseSendSuccess(
        `Transaction sent on ${currentNetwork.shortLabel}. Tx hash: ${hashStr}`
      );
      setBaseSendTxHash(hashStr);
      setBaseSendIsCrossChain(false);
      setBaseSendLifiStatus(null);
      setBaseAmount("");
      setBaseDestinationInput("");
      setBaseDestinationAddress(null);
      setBaseAmountExceedsBalance(false);
      refetchBaseBalances();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already known|replacement fee too low|nonce too low/i.test(msg)) {
        setBaseSendError(null);
      } else {
        setBaseSendError(msg);
      }
    } finally {
      setBaseSendLoading(false);
    }
  }, [
    baseSendLoading,
    evmAddress,
    embeddedEthWallet,
    currentNetwork,
    baseDestinationInput,
    baseAmount,
    selectedBaseToken,
    baseBalances,
    refetchBaseBalances,
  ]);

  const handleClaimSubdomain = useCallback(async () => {
    const label = claimLabel.trim().toLowerCase();
    if (label.length < 3) {
      setClaimError("Name must be at least 3 characters");
      return;
    }
    if (claimNameAvailable !== true) {
      setClaimError("Choose an available name");
      return;
    }
    if (!claimPreferredChain.trim()) {
      setClaimError("Select preferred chain");
      return;
    }
    const tokenValue =
      claimPreferredToken === "OTHER"
        ? claimPreferredTokenCustom.trim()
        : claimPreferredToken;
    if (!tokenValue) {
      setClaimError(
        claimPreferredToken === "OTHER"
          ? "Paste token address for Other"
          : "Select preferred token"
      );
      return;
    }
    if (!embeddedEthWallet || !registrarAddress) {
      setClaimError("Wallet or registrar not ready");
      return;
    }
    setClaimError(null);
    setClaimLoading(true);
    setClaimStep(1);
    try {
      const provider = await (embeddedEthWallet as any).getProvider();
      const chainIdHex = currentNetwork.evmChainId;
      if (!chainIdHex) throw new Error("Network not configured for EVM");
      try {
        const currentChainId = (await provider.request({ method: "eth_chainId" })) as string;
        if (currentChainId !== chainIdHex) {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: chainIdHex }],
          });
        }
      } catch (switchErr) {
        throw new Error("Failed to switch to Base. Enable Base in your Privy app.");
      }
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts?.[0];
      if (!from) throw new Error("No account in embedded wallet");

      // Use form values explicitly (no empty strings)
      const preferredChain = claimPreferredChain.trim();
      const preferredToken = tokenValue;
      const suiAddressParam = preferredChain === "Sui" ? (claimSuiAddress ?? "").trim() : "";
      if (!label || label.length < 3) throw new Error("Invalid label");
      if (!preferredChain) throw new Error("Preferred chain is required");
      if (!preferredToken) throw new Error("Preferred token is required");

      const calldata = getRegisterWithPreferencesCalldata(label, preferredChain, preferredToken, suiAddressParam);
      await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from,
          to: registrarAddress,
          data: calldata,
          chainId: chainIdHex,
          gasLimit: "0x80000", // ~524k for createSubnode + setAddr x2 + 3x setText (chain, token, optional Sui)
        }],
      });

      setClaimLabel("");
      setClaimPreferredChain("");
      setClaimPreferredToken("");
      setClaimPreferredTokenCustom("");
      setClaimSuiAddress("");
      setClaimNameAvailable(null);
      setClaimStep(null);
      refetchSubdomain();
      setTimeout(() => refetchSubdomain(), 3000);
      setTimeout(() => refetchSubdomain(), 12000);
    } catch (err: unknown) {
      const data = (err as { data?: unknown; error?: { data?: unknown } })?.data
        ?? (err as { error?: { data?: unknown } })?.error?.data;
      const friendly = getRegistrarRevertMessage(data);
      if (friendly) {
        setClaimError(friendly);
      } else {
        setClaimError(err instanceof Error ? err.message : "Claim failed. If the tx reverted, try: same wallet on Base, name still available, or edit preferences if you already have a name.");
      }
      setClaimStep(null);
    } finally {
      setClaimLoading(false);
    }
  }, [
    claimLabel,
    claimNameAvailable,
    claimPreferredChain,
    claimPreferredToken,
    claimPreferredTokenCustom,
    claimSuiAddress,
    embeddedEthWallet,
    currentNetwork.evmChainId,
    registrarAddress,
    refetchSubdomain,
  ]);

  const openEditPreferences = useCallback(() => {
    if (!subdomainStatus) return;
    const chain = subdomainStatus.preferredChain ?? "";
    const token = subdomainStatus.preferredToken ?? "";
    setEditPrefsChain(chain);
    setEditPrefsSuiAddress(subdomainStatus.suiAddress ?? "");
    if (token === "ETH" || token === "USDC" || token === "USDT") {
      setEditPrefsToken(token);
      setEditPrefsTokenCustom("");
    } else {
      setEditPrefsToken("OTHER");
      setEditPrefsTokenCustom(token);
    }
    setEditPrefsError(null);
    setEditPrefsVisible(true);
  }, [subdomainStatus]);

  const handleUpdatePreferences = useCallback(async () => {
    if (!editPrefsChain.trim()) {
      setEditPrefsError("Select preferred chain");
      return;
    }
    const tokenValue =
      editPrefsToken === "OTHER" ? editPrefsTokenCustom.trim() : editPrefsToken;
    if (!tokenValue) {
      setEditPrefsError(
        editPrefsToken === "OTHER"
          ? "Paste token address for Other"
          : "Select preferred token"
      );
      return;
    }
    if (!embeddedEthWallet || !registrarAddress) {
      setEditPrefsError("Wallet or registrar not ready");
      return;
    }
    setEditPrefsError(null);
    setEditPrefsLoading(true);
    try {
      const provider = await (embeddedEthWallet as any).getProvider();
      const chainIdHex = currentNetwork.evmChainId;
      if (!chainIdHex) throw new Error("Network not configured for EVM");
      try {
        const currentChainId = (await provider.request({ method: "eth_chainId" })) as string;
        if (currentChainId !== chainIdHex) {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: chainIdHex }],
          });
        }
      } catch (switchErr) {
        throw new Error("Failed to switch to Base. Enable Base in your Privy app.");
      }
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts?.[0];
      if (!from) throw new Error("No account in embedded wallet");

      const preferredChain = editPrefsChain.trim();
      const preferredToken = tokenValue;
      const suiAddressParam = preferredChain === "Sui" ? (editPrefsSuiAddress ?? "").trim() : "";
      if (!preferredChain) throw new Error("Preferred chain is required");
      if (!preferredToken) throw new Error("Preferred token is required");

      const prefsData = getSetPreferencesCalldata(preferredChain, preferredToken, suiAddressParam);
      await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from,
          to: registrarAddress,
          data: prefsData,
          chainId: chainIdHex,
          gasLimit: "0x80000", // ~524k for 3x setText (chain, token, optional Sui address)
        }],
      });

      setEditPrefsVisible(false);
      setTimeout(() => refetchSubdomain(), 5000);
    } catch (err: unknown) {
      const data = (err as { data?: unknown; error?: { data?: unknown } })?.data
        ?? (err as { error?: { data?: unknown } })?.error?.data;
      const friendly = getRegistrarRevertMessage(data);
      if (friendly) {
        setEditPrefsError(friendly);
      } else {
        setEditPrefsError(
          err instanceof Error
            ? err.message
            : "Update failed. Make sure you're on Base and using the same wallet that claimed your name."
        );
      }
    } finally {
      setEditPrefsLoading(false);
    }
  }, [
    editPrefsChain,
    editPrefsToken,
    editPrefsTokenCustom,
    editPrefsSuiAddress,
    embeddedEthWallet,
    currentNetwork.evmChainId,
    registrarAddress,
    refetchSubdomain,
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
          signRawHash as unknown as (params: {
            address: string;
            chainType: "sui";
            bytes: string;
            encoding: "hex";
            hash_function: "blake2b256";
          }) => Promise<{ signature: string }>,
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

  const insets = useSafeAreaInsets();
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
      ref={scrollViewRef}
      style={styles.scroll}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 24 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>Home</Text>
          <Text style={styles.subtitle}>{getTimeGreeting()}</Text>
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
            <View style={styles.drawerHeaderRow}>
              <Text style={[styles.drawerTitle, { color: colors.text }]}>
                Network
              </Text>
              <Pressable
                onPress={() => {
                  setNetworkDrawerVisible(false);
                  handleLogout();
                }}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
              >
                <Text style={[styles.drawerSignOut, { color: colors.tint }]}>
                  Sign out
                </Text>
              </Pressable>
            </View>
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
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      {currentNetwork.capabilities.showEvmWallet && (
        <>
          <View style={[styles.card, styles.walletCard, { borderColor: colors.tabIconDefault }]}>
            <Text style={[styles.cardLabel, styles.walletCardLabel]}>
              {currentNetwork.label} wallet
            </Text>
            {evmAddress ? (
              <>
                <Pressable
                  onPress={copyEvmAddress}
                  style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1 }]}
                >
                  <Text style={[styles.walletHero, { color: colors.text }]} selectable numberOfLines={1}>
                    {isBaseMainnet(currentNetwork.id) && subdomainStatus?.fullName
                      ? subdomainStatus.fullName
                      : evmAddress}
                  </Text>
                  <Text style={[styles.walletShort, { color: colors.text }]}>
                    {truncateAddress(evmAddress)}
                  </Text>
                  {copiedAddress && (
                    <Text style={[styles.walletCopied, { color: "#22c55e" }]}>
                      Copied
                    </Text>
                  )}
                </Pressable>
                {isBaseMainnet(currentNetwork.id) && subdomainStatus?.hasSubdomain && (
                  <View style={styles.walletPrefsRow}>
                    <View style={[styles.preferredPill, { backgroundColor: colors.tabIconDefault + "25", borderColor: colors.tabIconDefault + "50" }]}>
                      <Text style={[styles.preferredPillText, { color: colors.text }]}>
                        ★ {subdomainStatus.preferredChain ?? "—"} · {subdomainStatus.preferredToken ?? "—"}
                      </Text>
                    </View>
                    <View style={styles.walletActionsRow}>
                      <Pressable onPress={openEditPreferences} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                        <Text style={[styles.walletActionLink, { color: colors.tint }]}>Edit</Text>
                      </Pressable>
                      <Text style={[styles.walletActionDot, { color: colors.tabIconDefault }]}>·</Text>
                      <Pressable onPress={refetchSubdomain} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                        <Text style={[styles.walletActionLink, { color: colors.tint }]}>Refresh</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
                {isBaseMainnet(currentNetwork.id) && subdomainStatus?.hasSubdomain && (
                  <Pressable
                    onPress={() => setBaseQrVisible(true)}
                    style={({ pressed }) => ({
                      marginTop: 12,
                      alignSelf: "flex-start",
                      opacity: pressed ? 0.8 : 1,
                    })}
                  >
                    <Text
                      style={[styles.walletActionLink, { color: colors.tint }]}
                    >
                      Show QR to receive
                    </Text>
                  </Pressable>
                )}
              </>
            ) : (
              <Text style={[styles.muted, { color: colors.text }]}>
                No {currentNetwork.label} wallet linked. Add one in your Privy account.
              </Text>
            )}
          </View>

          <Modal
            visible={baseQrVisible}
            transparent
            animationType="fade"
            onRequestClose={() => setBaseQrVisible(false)}
          >
            <Pressable
              style={styles.modalOverlay}
              onPress={() => setBaseQrVisible(false)}
            >
              <View style={styles.qrModalContent} onStartShouldSetResponder={() => true}>
                <Text
                  style={[
                    styles.inputLabel,
                    { color: colors.text, marginBottom: 12 },
                  ]}
                >
                  Receive money
                </Text>
                {evmAddress ? (
                  <>
                    <View style={styles.qrCard}>
                      <View style={styles.qrInner}>
                        <QRCode
                          value={`ghostwater://?type=pay&handle=${encodeURIComponent(
                            subdomainStatus?.fullName ?? evmAddress
                          )}&address=${encodeURIComponent(
                            evmAddress
                          )}&chain=${encodeURIComponent(
                            currentNetwork.id
                          )}${
                            subdomainStatus?.preferredToken
                              ? `&token=${encodeURIComponent(
                                  subdomainStatus.preferredToken
                                )}`
                              : ""
                          }`}
                          size={220}
                          color="#ffffff"
                          backgroundColor="transparent"
                        />
                      </View>
                      <Text
                        style={[
                          styles.qrHandle,
                          { color: colors.text },
                        ]}
                        numberOfLines={1}
                      >
                        {subdomainStatus?.fullName ?? truncateAddress(evmAddress)}
                      </Text>
                      {subdomainStatus?.preferredChain && (
                        <Text style={styles.qrMeta}>
                          {subdomainStatus.preferredChain} ·{" "}
                          {subdomainStatus.preferredToken ?? "—"}
                        </Text>
                      )}
                    </View>
                  </>
                ) : (
                  <Text style={styles.muted}>
                    No wallet address available.
                  </Text>
                )}
              </View>
            </Pressable>
          </Modal>

          {isBaseMainnet(currentNetwork.id) && evmAddress && registrarAddress && (
            <>
              {subdomainLoading ? (
                <View style={styles.card}>
                  <ActivityIndicator size="small" color={colors.tint} />
                  <Text style={styles.muted}>Checking subdomain…</Text>
                </View>
              ) : subdomainError ? (
                <View style={styles.card}>
                  <Text style={styles.error}>{subdomainError}</Text>
                  <Pressable onPress={refetchSubdomain} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
                    <Text style={[styles.muted, { color: colors.tint, marginTop: 8 }]}>Tap to retry</Text>
                  </Pressable>
                </View>
              ) : !subdomainStatus?.hasSubdomain ? (
                <View style={styles.card}>
                  <Animated.Text style={[styles.subdomainHeading, { color: colors.text, opacity: subdomainBlinkAnim }]}>
                    Choose your Ghostwater name
                  </Animated.Text>
                  <Text style={[styles.inputLabel, { color: colors.text, marginTop: 8 }]}>Name (min 3 characters)</Text>
                  <TextInput
                    style={[
                      styles.input,
                      styles.subdomainInput,
                      { color: colors.text },
                    ]}
                    placeholder="e.g. alice"
                    placeholderTextColor={colors.text + "80"}
                    value={claimLabel}
                    onChangeText={(t) => {
                      setClaimLabel(t);
                      setClaimError(null);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!claimLoading}
                  />
                  {claimCheckingName && (
                    <Text style={styles.muted}>Checking availability…</Text>
                  )}
                  {!claimCheckingName && claimNameAvailable === true && (
                    <Text style={[styles.muted, { color: "#22c55e" }]}>Available</Text>
                  )}
                  {!claimCheckingName && claimNameAvailable === false && (
                    <Text style={[styles.muted, { color: "#ef4444" }]}>Already taken</Text>
                  )}
                  <Text style={[styles.inputLabel, { color: colors.text, marginTop: 12 }]}>Preferred chain</Text>
                  <Pressable
                    onPress={() => !claimLoading && setChainPickerVisible(true)}
                    style={[
                      styles.input,
                      styles.subdomainInput,
                      styles.dropdown,
                      {
                        borderColor: colors.tabIconDefault,
                        opacity: claimLoading ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Text style={{ fontSize: 14, color: colors.text }}>
                      {claimPreferredChain || "Select chain"}
                    </Text>
                    <FontAwesome name="chevron-down" size={14} color={colors.tabIconDefault} />
                  </Pressable>
                  <Modal
                    visible={chainPickerVisible}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setChainPickerVisible(false)}
                  >
                    <Pressable style={styles.modalOverlay} onPress={() => setChainPickerVisible(false)}>
                      <View
                        style={[styles.modalContent, { backgroundColor: colors.background, borderColor: colors.tabIconDefault }]}
                        onStartShouldSetResponder={() => true}
                      >
                        <Text style={[styles.inputLabel, { color: colors.text }]}>Select chain</Text>
                        <ScrollView style={{ maxHeight: 240 }}>
                          {PREFERRED_CHAIN_OPTIONS.map((chain) => (
                            <Pressable
                              key={chain}
                              onPress={() => {
                                setClaimPreferredChain(chain);
                                setChainPickerVisible(false);
                                setClaimError(null);
                              }}
                              style={({ pressed }) => [
                                styles.pickerItem,
                                {
                                  backgroundColor: claimPreferredChain === chain ? colors.tabIconDefault + "30" : "transparent",
                                  opacity: pressed ? 0.8 : 1,
                                },
                              ]}
                            >
                              <Text style={{ fontSize: 14, color: colors.text }}>{chain}</Text>
                            </Pressable>
                          ))}
                        </ScrollView>
                      </View>
                    </Pressable>
                  </Modal>

                  <Text style={[styles.inputLabel, { color: colors.text, marginTop: 12 }]}>Preferred token</Text>
                  <Pressable
                    onPress={() => !claimLoading && setTokenPickerVisibleSubdomain(true)}
                    style={[
                      styles.input,
                      styles.subdomainInput,
                      styles.dropdown,
                      {
                        borderColor: colors.tabIconDefault,
                        opacity: claimLoading ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Text style={{ fontSize: 14, color: colors.text }}>
                      {claimPreferredToken
                        ? PREFERRED_TOKEN_OPTIONS.find((o) => o.value === claimPreferredToken)?.label ?? claimPreferredToken
                        : "Select token"}
                    </Text>
                    <FontAwesome name="chevron-down" size={14} color={colors.tabIconDefault} />
                  </Pressable>
                  {claimPreferredToken === "OTHER" && (
                    <TextInput
                      style={[
                        styles.input,
                        styles.subdomainInput,
                        { color: colors.text, marginTop: 8, borderColor: colors.tabIconDefault },
                      ]}
                      placeholder="Paste token contract address (0x...)"
                      placeholderTextColor={colors.text + "80"}
                      value={claimPreferredTokenCustom}
                      onChangeText={(t) => {
                        setClaimPreferredTokenCustom(t);
                        setClaimError(null);
                      }}
                      editable={!claimLoading}
                    />
                  )}
                  {claimPreferredChain === "Sui" && (
                    <>
                      <Text style={[styles.inputLabel, { color: colors.text, marginTop: 12 }]}>Sui receive address</Text>
                      <TextInput
                        style={[
                          styles.input,
                          styles.subdomainInput,
                          { color: colors.text, marginTop: 4, borderColor: colors.tabIconDefault },
                        ]}
                        placeholder="0x... (for cross-chain sends to Sui)"
                        placeholderTextColor={colors.text + "80"}
                        value={claimSuiAddress}
                        onChangeText={(t) => {
                          setClaimSuiAddress(t);
                          setClaimError(null);
                        }}
                        editable={!claimLoading}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </>
                  )}
                  <Modal
                    visible={tokenPickerVisibleSubdomain}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setTokenPickerVisibleSubdomain(false)}
                  >
                    <Pressable style={styles.modalOverlay} onPress={() => setTokenPickerVisibleSubdomain(false)}>
                      <View
                        style={[styles.modalContent, { backgroundColor: colors.background, borderColor: colors.tabIconDefault }]}
                        onStartShouldSetResponder={() => true}
                      >
                        <Text style={[styles.inputLabel, { color: colors.text }]}>Select token</Text>
                        <ScrollView style={{ maxHeight: 240 }}>
                          {PREFERRED_TOKEN_OPTIONS.map((opt) => (
                            <Pressable
                              key={opt.value}
                              onPress={() => {
                                setClaimPreferredToken(opt.value);
                                setTokenPickerVisibleSubdomain(false);
                                setClaimError(null);
                              }}
                              style={({ pressed }) => [
                                styles.pickerItem,
                                {
                                  backgroundColor: claimPreferredToken === opt.value ? colors.tabIconDefault + "30" : "transparent",
                                  opacity: pressed ? 0.8 : 1,
                                },
                              ]}
                            >
                              <Text style={{ fontSize: 14, color: colors.text }}>{opt.label}</Text>
                            </Pressable>
                          ))}
                        </ScrollView>
                      </View>
                    </Pressable>
                  </Modal>
                  {claimError && (
                    <Text style={[styles.error, { marginTop: 8 }]}>{claimError}</Text>
                  )}
                  <Pressable
                    onPress={handleClaimSubdomain}
                    disabled={
                      claimLoading ||
                      claimNameAvailable !== true ||
                      !claimPreferredChain.trim() ||
                      !claimPreferredToken ||
                      (claimPreferredToken === "OTHER" && !claimPreferredTokenCustom.trim())
                    }
                    style={({ pressed }) => [
                      styles.primaryButton,
                      { backgroundColor: colors.tint, opacity: claimLoading || claimNameAvailable !== true ? 0.6 : pressed ? 0.8 : 1 },
                    ]}
                  >
                    <Text style={[styles.primaryButtonText, { color: colors.background }]}>
                      {claimLoading ? "Claiming…" : "Claim name & set preferences"}
                    </Text>
                  </Pressable>
                  <Text style={[styles.muted, { marginTop: 8, fontSize: 12 }]}>
                    One tx: claim name and set preferences. We’ll refresh in ~15s after.
                  </Text>
                </View>
              ) : null}

              {/* Edit preferences modal (when user has subdomain) */}
              <Modal
                visible={editPrefsVisible}
                transparent
                animationType="fade"
                onRequestClose={() => !editPrefsLoading && setEditPrefsVisible(false)}
              >
                <Pressable
                  style={styles.modalOverlay}
                  onPress={() => !editPrefsLoading && setEditPrefsVisible(false)}
                >
                  <View
                    style={[
                      styles.modalContent,
                      styles.editPrefsModalContent,
                      {
                        backgroundColor: colors.background,
                        borderColor: colors.tabIconDefault,
                      },
                    ]}
                    onStartShouldSetResponder={() => true}
                  >
                    <ScrollView
                      style={styles.editPrefsModalScroll}
                      contentContainerStyle={styles.editPrefsModalScrollContent}
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={false}
                    >
                    <Text style={[styles.inputLabel, { color: colors.text }]}>
                      Edit preferences
                    </Text>
                    <Text style={[styles.inputLabel, { color: colors.text, marginTop: 12 }]}>
                      Preferred chain
                    </Text>
                    <Pressable
                      onPress={() => !editPrefsLoading && setEditChainPickerVisible(true)}
                      style={[
                        styles.input,
                        styles.subdomainInput,
                        styles.dropdown,
                        {
                          borderColor: colors.tabIconDefault,
                          opacity: editPrefsLoading ? 0.6 : 1,
                        },
                      ]}
                    >
                      <Text style={{ fontSize: 14, color: colors.text }}>
                        {editPrefsChain || "Select chain"}
                      </Text>
                      <FontAwesome name="chevron-down" size={14} color={colors.tabIconDefault} />
                    </Pressable>
                    <Modal
                      visible={editChainPickerVisible}
                      transparent
                      animationType="fade"
                      onRequestClose={() => setEditChainPickerVisible(false)}
                    >
                      <Pressable style={styles.modalOverlay} onPress={() => setEditChainPickerVisible(false)}>
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
                          <Text style={[styles.inputLabel, { color: colors.text }]}>Select chain</Text>
                          <ScrollView style={{ maxHeight: 240 }}>
                            {PREFERRED_CHAIN_OPTIONS.map((chain) => (
                              <Pressable
                                key={chain}
                                onPress={() => {
                                  setEditPrefsChain(chain);
                                  setEditChainPickerVisible(false);
                                  setEditPrefsError(null);
                                }}
                                style={({ pressed }) => [
                                  styles.pickerItem,
                                  {
                                    backgroundColor:
                                      editPrefsChain === chain ? colors.tabIconDefault + "30" : "transparent",
                                    opacity: pressed ? 0.8 : 1,
                                  },
                                ]}
                              >
                                <Text style={{ fontSize: 14, color: colors.text }}>{chain}</Text>
                              </Pressable>
                            ))}
                          </ScrollView>
                        </View>
                      </Pressable>
                    </Modal>

                    <Text style={[styles.inputLabel, { color: colors.text, marginTop: 12 }]}>
                      Preferred token
                    </Text>
                    <Pressable
                      onPress={() => !editPrefsLoading && setEditTokenPickerVisible(true)}
                      style={[
                        styles.input,
                        styles.subdomainInput,
                        styles.dropdown,
                        {
                          borderColor: colors.tabIconDefault,
                          opacity: editPrefsLoading ? 0.6 : 1,
                        },
                      ]}
                    >
                      <Text style={{ fontSize: 14, color: colors.text }}>
                        {editPrefsToken
                          ? PREFERRED_TOKEN_OPTIONS.find((o) => o.value === editPrefsToken)?.label ?? editPrefsToken
                          : "Select token"}
                      </Text>
                      <FontAwesome name="chevron-down" size={14} color={colors.tabIconDefault} />
                    </Pressable>
                    {editPrefsChain === "Sui" && editPrefsToken === "OTHER" && (
                      <TextInput
                        style={[
                          styles.input,
                          styles.subdomainInput,
                          { color: colors.text, marginTop: 8, borderColor: colors.tabIconDefault },
                        ]}
                        placeholder="Paste token contract address (0x...)"
                        placeholderTextColor={colors.text + "80"}
                        value={editPrefsTokenCustom}
                        onChangeText={(t) => {
                          setEditPrefsTokenCustom(t);
                          setEditPrefsError(null);
                        }}
                        editable={!editPrefsLoading}
                      />
                    )}
                    {editPrefsChain === "Sui" && (
                      <>
                        <Text style={[styles.inputLabel, { color: colors.text, marginTop: 12 }]}>
                          Sui receive address
                        </Text>
                        <TextInput
                          style={[
                            styles.input,
                            styles.subdomainInput,
                            { color: colors.text, marginTop: 4, borderColor: colors.tabIconDefault },
                          ]}
                          placeholder="0x... (for cross-chain sends to Sui)"
                          placeholderTextColor={colors.text + "80"}
                          value={editPrefsSuiAddress}
                          onChangeText={(t) => {
                            setEditPrefsSuiAddress(t);
                            setEditPrefsError(null);
                          }}
                          editable={!editPrefsLoading}
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      </>
                    )}
                    <Modal
                      visible={editTokenPickerVisible}
                      transparent
                      animationType="fade"
                      onRequestClose={() => setEditTokenPickerVisible(false)}
                    >
                      <Pressable style={styles.modalOverlay} onPress={() => setEditTokenPickerVisible(false)}>
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
                          <Text style={[styles.inputLabel, { color: colors.text }]}>Select token</Text>
                          <ScrollView style={{ maxHeight: 240 }}>
                            {PREFERRED_TOKEN_OPTIONS.map((opt) => (
                              <Pressable
                                key={opt.value}
                                onPress={() => {
                                  setEditPrefsToken(opt.value);
                                  setEditTokenPickerVisible(false);
                                  setEditPrefsError(null);
                                }}
                                style={({ pressed }) => [
                                  styles.pickerItem,
                                  {
                                    backgroundColor:
                                      editPrefsToken === opt.value ? colors.tabIconDefault + "30" : "transparent",
                                    opacity: pressed ? 0.8 : 1,
                                  },
                                ]}
                              >
                                <Text style={{ fontSize: 14, color: colors.text }}>{opt.label}</Text>
                              </Pressable>
                            ))}
                          </ScrollView>
                        </View>
                      </Pressable>
                    </Modal>

                    {editPrefsError && (
                      <Text style={[styles.error, { marginTop: 8 }]}>{editPrefsError}</Text>
                    )}
                    </ScrollView>
                    <Pressable
                      onPress={handleUpdatePreferences}
                      disabled={
                        editPrefsLoading ||
                        !editPrefsChain.trim() ||
                        !editPrefsToken ||
                        (editPrefsToken === "OTHER" && !editPrefsTokenCustom.trim())
                      }
                      style={({ pressed }) => [
                        styles.primaryButton,
                        {
                          backgroundColor: colors.tint,
                          opacity:
                            editPrefsLoading || !editPrefsChain.trim() || !editPrefsToken ? 0.6 : pressed ? 0.8 : 1,
                        },
                      ]}
                    >
                      <Text style={[styles.primaryButtonText, { color: colors.background }]}>
                        {editPrefsLoading ? "Updating…" : "Update preferences"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => !editPrefsLoading && setEditPrefsVisible(false)}
                      style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1, marginTop: 8 }]}
                    >
                      <Text style={[styles.muted, { color: colors.text }]}>Cancel</Text>
                    </Pressable>
                  </View>
                </Pressable>
              </Modal>
            </>
          )}

          <View style={[styles.card, { borderColor: colors.tabIconDefault }]}>
            <Text style={[styles.cardLabel, { color: colors.text }]}>
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

          <View style={[styles.card, { borderColor: colors.tabIconDefault }]}>
            <Text style={[styles.cardLabel, { color: colors.text }]}>
              Send on {currentNetwork.shortLabel}
            </Text>
            <Text style={[styles.muted, { fontSize: 11, marginBottom: 12 }]}>
              Send to a 0x address or a Ghostwater name (e.g. alice.ghostwater.eth)
            </Text>
            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Token
            </Text>
            <Pressable
              onPress={() => baseBalances.length > 0 && setBaseSendTokenPickerVisible(true)}
              style={[
                styles.input,
                styles.dropdown,
                {
                  borderColor: colors.tabIconDefault,
                  opacity: baseBalances.length === 0 ? 0.6 : 1,
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

            <Modal
              visible={baseSendTokenPickerVisible}
              transparent
              animationType="fade"
              onRequestClose={() => setBaseSendTokenPickerVisible(false)}
            >
              <Pressable
                style={styles.modalOverlay}
                onPress={() => setBaseSendTokenPickerVisible(false)}
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
                    {baseBalances.length === 0 ? (
                      <Text style={[styles.muted, { paddingVertical: 12 }]}>
                        No tokens
                      </Text>
                    ) : (
                      baseBalances.map((b) => (
                        <Pressable
                          key={b.tokenAddress ?? "native"}
                          onPress={() => {
                            setSelectedBaseToken(b.tokenAddress ?? "native");
                            setBaseSendTokenPickerVisible(false);
                            setBaseAmountExceedsBalance(false);
                          }}
                          style={({ pressed }) => [
                            styles.pickerItem,
                            {
                              backgroundColor:
                                (b.tokenAddress ?? "native") === selectedBaseToken
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
                  borderColor: baseAmountExceedsBalance
                    ? "#c00"
                    : colors.tabIconDefault,
                },
              ]}
              placeholder="0"
              placeholderTextColor={colors.tabIconDefault + "99"}
              value={baseAmount}
              onChangeText={(t) => {
                setBaseAmount(t);
                setBaseSendError(null);
                setBaseSendSuccess(null);
                setBaseSendTxHash(null);
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
              placeholder="0x… or name.ghostwater.eth"
              placeholderTextColor={colors.tabIconDefault + "99"}
              value={baseDestinationInput}
              onChangeText={(t) => {
                setBaseDestinationInput(t);
                setBaseDestinationAddress(null);
                setResolvedToAddressDisplay(null);
                setResolvedToAddressLabel(null);
                setBaseSendError(null);
                setBaseSendSuccess(null);
                setBaseSendTxHash(null);
                setBaseSendIsCrossChain(false);
                setBaseSendLifiStatus(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {(resolvedToAddressLoading || resolvedToAddressDisplay) && (
              <View style={{ marginTop: 8 }}>
                <Text style={[styles.inputLabel, { color: colors.text, marginBottom: 4 }]}>
                  To address{resolvedToAddressLabel ? ` (${resolvedToAddressLabel})` : ""}
                </Text>
                <View
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.tabIconDefault + "18",
                      borderColor: colors.tabIconDefault,
                      minHeight: 44,
                      justifyContent: "center",
                    },
                  ]}
                >
                  {resolvedToAddressLoading ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <ActivityIndicator size="small" color={colors.tabIconDefault} />
                      <Text style={[styles.muted, { color: colors.text }]}>Resolving…</Text>
                    </View>
                  ) : resolvedToAddressDisplay ? (
                    <Text
                      style={[styles.muted, { color: colors.text }]}
                      selectable
                      numberOfLines={2}
                    >
                      {resolvedToAddressDisplay}
                    </Text>
                  ) : null}
                </View>
              </View>
            )}
            {baseSendError ? (
              <Text style={styles.error}>{baseSendError}</Text>
            ) : null}
            {baseSendSuccess ? (
              <View
                style={[
                  styles.sendSuccessCard,
                  {
                    backgroundColor: colors.background,
                    borderColor: "#22c55e40",
                  },
                ]}
              >
                <Text style={[styles.sendSuccessTitle, { color: "#22c55e" }]}>
                  {baseSendIsCrossChain ? "Cross-chain send submitted" : "Transaction sent"}
                </Text>
                {baseSendTxHash ? (
                  <Pressable
                    onPress={() => {
                      Clipboard.setString(baseSendTxHash);
                      setBaseTxHashCopied(true);
                      setTimeout(() => setBaseTxHashCopied(false), 2000);
                    }}
                    style={({ pressed }) => ({
                      opacity: pressed ? 0.8 : 1,
                      marginTop: 6,
                      paddingVertical: 4,
                    })}
                  >
                    <Text
                      style={[styles.sendSuccessHash, { color: colors.text }]}
                      selectable
                      numberOfLines={2}
                    >
                      {baseSendTxHash}
                    </Text>
                    <Text style={[styles.muted, { color: "#22c55e99", fontSize: 11, marginTop: 2 }]}>
                      {baseTxHashCopied ? "Copied!" : "Tap to copy"}
                    </Text>
                  </Pressable>
                ) : (
                  <Text
                    style={[styles.muted, { color: "#22c55e", marginTop: 4 }]}
                    selectable
                  >
                    {baseSendSuccess.replace(/^.*Tx:? /, "").replace(/^.*Tx hash: /, "")}
                  </Text>
                )}
                {baseSendIsCrossChain && baseSendLifiStatus ? (
                  <>
                    <View
                      style={[
                        styles.sendStatusBadge,
                        {
                          backgroundColor:
                            baseSendLifiStatus.status === "DONE"
                              ? "#22c55e22"
                              : baseSendLifiStatus.status === "FAILED"
                                ? "#ef444422"
                                : "#eab30822",
                          borderColor:
                            baseSendLifiStatus.status === "DONE"
                              ? "#22c55e"
                              : baseSendLifiStatus.status === "FAILED"
                                ? "#ef4444"
                                : "#eab308",
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.sendStatusBadgeText,
                          {
                            color:
                              baseSendLifiStatus.status === "DONE"
                                ? "#22c55e"
                                : baseSendLifiStatus.status === "FAILED"
                                  ? "#ef4444"
                                  : "#eab308",
                          },
                        ]}
                      >
                        {baseSendLifiStatus.status === "PENDING"
                          ? "Bridging"
                          : baseSendLifiStatus.status === "DONE"
                            ? "Complete"
                            : baseSendLifiStatus.status === "FAILED"
                              ? "Failed"
                              : baseSendLifiStatus.status}
                      </Text>
                    </View>
                    {(baseSendLifiStatus.substatusMessage != null) &&
                     baseSendLifiStatus.status === "PENDING" ? (
                      <Text
                        style={[styles.muted, { color: colors.text, fontSize: 11, marginTop: 6 }]}
                        numberOfLines={2}
                      >
                        {baseSendLifiStatus.substatusMessage}
                      </Text>
                    ) : null}
                    <View style={styles.sendSuccessLinks}>
                      {baseSendLifiStatus.sending?.txLink ? (
                        <Pressable
                          onPress={() =>
                            baseSendLifiStatus.sending?.txLink &&
                            Linking.openURL(baseSendLifiStatus.sending.txLink)
                          }
                          style={({ pressed }) => [styles.sendSuccessLink, { opacity: pressed ? 0.8 : 1 }]}
                        >
                          <Text style={[styles.sendSuccessLinkText, { color: colors.tint }]}>
                            Source tx
                          </Text>
                        </Pressable>
                      ) : null}
                      {baseSendLifiStatus.receiving?.txLink ? (
                        <Pressable
                          onPress={() =>
                            baseSendLifiStatus.receiving?.txLink &&
                            Linking.openURL(baseSendLifiStatus.receiving.txLink)
                          }
                          style={({ pressed }) => [styles.sendSuccessLink, { opacity: pressed ? 0.8 : 1 }]}
                        >
                          <Text style={[styles.sendSuccessLinkText, { color: colors.tint }]}>
                            Destination tx
                          </Text>
                        </Pressable>
                      ) : null}
                      {baseSendLifiStatus.lifiExplorerLink ? (
                        <Pressable
                          onPress={() =>
                            baseSendLifiStatus?.lifiExplorerLink &&
                            Linking.openURL(baseSendLifiStatus.lifiExplorerLink)
                          }
                          style={({ pressed }) => [styles.sendSuccessLink, { opacity: pressed ? 0.8 : 1 }]}
                        >
                          <Text style={[styles.sendSuccessLinkText, { color: colors.tint }]}>
                            Track on LI.FI
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </>
                ) : baseSendIsCrossChain && baseSendTxHash ? (
                  <View style={{ marginTop: 10 }}>
                    <View style={[styles.sendStatusBadge, { backgroundColor: "#eab30822", borderColor: "#eab308" }]}>
                      <Text style={[styles.sendStatusBadgeText, { color: "#eab308" }]}>Checking…</Text>
                    </View>
                    <Pressable
                      onPress={() => Linking.openURL(`https://scan.li.fi/tx/${baseSendTxHash}`)}
                      style={({ pressed }) => [styles.sendSuccessLink, { marginTop: 8, opacity: pressed ? 0.8 : 1 }]}
                    >
                      <Text style={[styles.sendSuccessLinkText, { color: colors.tint }]}>
                        Track on LI.FI
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
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
                !baseDestinationInput.trim() ||
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
                    !baseDestinationInput.trim() ||
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
                  borderColor: colors.tabIconDefault,
                },
              ]}
            >
              <Text style={{ fontSize: 14, color: colors.text }}>
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
  walletCard: {
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  walletCardLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
    opacity: 0.55,
    marginBottom: 12,
  },
  walletHero: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  walletShort: {
    fontSize: 13,
    opacity: 0.5,
    marginBottom: 12,
  },
  walletCopied: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
  },
  walletPrefsRow: {
    marginTop: 4,
    gap: 10,
  },
  preferredPill: {
    alignSelf: "flex-start",
    paddingLeft: 0,
    paddingRight: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  preferredPillText: {
    fontSize: 13,
    fontWeight: "500",
    opacity: 0.9,
  },
  walletActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  walletActionLink: {
    fontSize: 13,
    fontWeight: "500",
  },
  walletActionDot: {
    fontSize: 13,
    opacity: 0.5,
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
  subdomainHeading: {
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 4,
  },
  subdomainInput: {
    borderWidth: 1.5,
    borderColor: "rgba(128,128,128,0.55)",
    backgroundColor: "rgba(128,128,128,0.12)",
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
  editPrefsModalContent: {
    maxHeight: "80%",
  },
  editPrefsModalScroll: {
    maxHeight: 280,
  },
  editPrefsModalScrollContent: {
    paddingBottom: 8,
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
  sendSuccessCard: {
    marginTop: 16,
    marginBottom: 8,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  sendSuccessTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  sendSuccessHash: {
    fontSize: 12,
    fontFamily: "SpaceMono",
    opacity: 0.9,
  },
  sendStatusBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 10,
  },
  sendStatusBadgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  sendSuccessLinks: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 10,
  },
  sendSuccessLink: {
    paddingVertical: 4,
  },
  sendSuccessLinkText: {
    fontSize: 12,
    textDecorationLine: "underline",
    fontWeight: "500",
  },
  primaryButtonText: {
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
  drawerHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  drawerTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 4,
  },
  drawerSignOut: {
    fontSize: 14,
    fontWeight: "600",
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
  },
  drawerItemTitleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  drawerItemTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  drawerActivePill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "600",
  },
  qrModalContent: {
    alignItems: "center",
  },
  qrCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.5)",
    backgroundColor: "rgba(15,15,15,0.95)",
    alignItems: "center",
  },
  qrInner: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#000",
  },
  qrHandle: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: "600",
  },
  qrMeta: {
    marginTop: 4,
    fontSize: 13,
    opacity: 0.7,
  },
});
