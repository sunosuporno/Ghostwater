/**
 * Swap / Bridge — Base only.
 * From: fixed Base + user's wallet tokens (enriched with LI.FI token details).
 * To: chain selector (LI.FI chains) + tokens for selected chain (LI.FI tokens).
 */

import { useEmbeddedEthereumWallet } from "@privy-io/expo";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/Themed";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import {
  fetchLifiChains,
  fetchLifiToken,
  fetchLifiTokensForChains,
  getSwapChains,
  LIFI_BASE_CHAIN_ID,
  LIFI_SOLANA_CHAIN_ID,
  LIFI_SUI_CHAIN_ID,
  LifiChain,
  LifiToken,
  NATIVE_TOKEN_ADDRESS,
} from "@/lib/lifi-chains-tokens";
import {
  fetchAllBaseBalances,
  type BaseBalanceItem,
} from "@/lib/base-balance-fetch";
import { fetchLifiQuote } from "@/lib/lifi-quote";
import { useNetwork } from "@/lib/network";

/**
 * Base chain logo — must be PNG/JPG/WebP (React Native Image does not support SVG).
 * LI.FI returns .svg so we use a raster URL for display.
 */
const BASE_CHAIN_LOGO_URI = "https://icons.llamao.fi/icons/chains/rsz_base.jpg";

function addressEq(a: string | null, b: string | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** From-side token: wallet balance + optional LI.FI details (logo, etc.) */
type FromTokenOption = BaseBalanceItem & { lifiToken?: LifiToken | null };

export default function SwapScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const insets = useSafeAreaInsets();
  const { currentNetwork } = useNetwork();
  const { wallets: embeddedEthWallets } = useEmbeddedEthereumWallet();
  const embeddedEthWallet = embeddedEthWallets?.[0];

  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [baseBalances, setBaseBalances] = useState<FromTokenOption[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [chains, setChains] = useState<LifiChain[]>([]);
  const [chainsLoading, setChainsLoading] = useState(false);
  const [tokensByChain, setTokensByChain] = useState<Record<string, LifiToken[]>>({});
  const [tokensLoading, setTokensLoading] = useState(false);

  const [fromToken, setFromToken] = useState<FromTokenOption | null>(null);
  const [fromTokenLifiDetail, setFromTokenLifiDetail] = useState<LifiToken | null>(null);
  const [toChain, setToChain] = useState<LifiChain | null>(null);
  const [toToken, setToToken] = useState<LifiToken | null>(null);
  const [amount, setAmount] = useState("");

  const [toDrawerVisible, setToDrawerVisible] = useState(false);
  const [toDrawerStep, setToDrawerStep] = useState<"chain" | "token">("chain");
  const [tokenSearchQuery, setTokenSearchQuery] = useState("");
  const [destinationSameAsSource, setDestinationSameAsSource] = useState(true);
  const [toAddress, setToAddress] = useState("");

  const [toAmountDisplay, setToAmountDisplay] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quoteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quoteRequestIdRef = useRef(0);

  const [swapLoading, setSwapLoading] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapSuccess, setSwapSuccess] = useState<string | null>(null);

  const isBase = currentNetwork.id === "base-mainnet";

  const baseChain = chains.find((c) => c.id === LIFI_BASE_CHAIN_ID);
  const hasLoggedBaseChainRef = useRef(false);

  useEffect(() => {
    if (baseChain?.logoURI && isBase && !hasLoggedBaseChainRef.current) {
      hasLoggedBaseChainRef.current = true;
      console.log("[Swap] Base chain logo arrived", baseChain.logoURI);
    }
  }, [baseChain?.logoURI, isBase]);

  const refetchBalances = useCallback(() => {
    if (!evmAddress || !isBase) {
      setBaseBalances([]);
      setBalanceError(null);
      return;
    }
    setBalanceError(null);
    setBalanceLoading(true);
    fetchAllBaseBalances(evmAddress, "base-mainnet")
      .then((list) => setBaseBalances(list.map((b) => ({ ...b, lifiToken: undefined }))))
      .catch((err) => {
        setBalanceError(err instanceof Error ? err.message : "Failed to load balances");
        setBaseBalances([]);
      })
      .finally(() => setBalanceLoading(false));
  }, [evmAddress, isBase]);

  useEffect(() => {
    if (!embeddedEthWallet) {
      setEvmAddress(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const provider = await (embeddedEthWallet as any).getProvider();
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        if (!cancelled) setEvmAddress(accounts?.[0] ?? null);
      } catch {
        if (!cancelled) setEvmAddress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embeddedEthWallet]);

  useEffect(() => {
    if (evmAddress && isBase) refetchBalances();
  }, [evmAddress, isBase, refetchBalances]);

  useEffect(() => {
    if (!isBase) return;
    setChainsLoading(true);
    fetchLifiChains()
      .then((list) => setChains(getSwapChains(list)))
      .catch(() => setChains([]))
      .finally(() => setChainsLoading(false));
  }, [isBase]);

  const toChainIdStr = toChain ? String(toChain.id) : "";
  const toTokens = (toChainIdStr && tokensByChain[toChainIdStr]) || [];
  const isToChainSuiOrSolana =
    toChain &&
    (toChain.id === LIFI_SUI_CHAIN_ID || toChain.id === LIFI_SOLANA_CHAIN_ID);
  const tokenSearchLower = tokenSearchQuery.trim().toLowerCase();
  const filteredToTokens = tokenSearchLower
    ? toTokens.filter(
        (t) =>
          t.symbol.toLowerCase().includes(tokenSearchLower) ||
          (t.name && t.name.toLowerCase().includes(tokenSearchLower))
      )
    : toTokens;
  const fromTokenAddressForCompare =
    fromToken ? (fromToken.tokenAddress ?? NATIVE_TOKEN_ADDRESS).toLowerCase() : "";
  const selectableToTokens =
    toChain?.id === LIFI_BASE_CHAIN_ID && fromTokenAddressForCompare
      ? filteredToTokens.filter(
          (t) => t.address.toLowerCase() !== fromTokenAddressForCompare
        )
      : filteredToTokens;
  const isSameTokenSameNetwork =
    toChain?.id === LIFI_BASE_CHAIN_ID &&
    !!fromToken &&
    !!toToken &&
    toToken.address.toLowerCase() === fromTokenAddressForCompare;

  useEffect(() => {
    if (isSameTokenSameNetwork && toToken) setToToken(null);
  }, [isSameTokenSameNetwork, toToken]);

  useEffect(() => {
    if (!isBase || !toChain) return;
    const chainIdStr = String(toChain.id);
    if (tokensByChain[chainIdStr] !== undefined) return;
    setTokensLoading(true);
    fetchLifiTokensForChains([toChain.id])
      .then((byChain) => {
        setTokensByChain((prev) => ({ ...prev, ...byChain }));
      })
      .catch(() => {
        setTokensByChain((prev) => ({ ...prev, [chainIdStr]: [] }));
      })
      .finally(() => setTokensLoading(false));
  }, [isBase, toChain?.id]);

  useEffect(() => {
    if (!fromToken || !isBase) {
      setFromTokenLifiDetail(null);
      return;
    }
    const chainKey = String(LIFI_BASE_CHAIN_ID);
    const tokenParam =
      fromToken.tokenAddress ?? NATIVE_TOKEN_ADDRESS;
    let cancelled = false;
    fetchLifiToken(chainKey, tokenParam)
      .then((t) => {
        if (!cancelled) setFromTokenLifiDetail(t);
      })
      .catch(() => {
        if (!cancelled) setFromTokenLifiDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fromToken?.tokenAddress, fromToken?.symbol, isBase]);

  // Debounced LI.FI quote: wait 1s after amount/tokens change, then fetch quote and set To amount
  useEffect(() => {
    const haveAll =
      fromToken &&
      toChain &&
      toToken &&
      evmAddress &&
      amount.trim() !== "" &&
      parseFloat(amount) > 0;

    if (!haveAll) {
      if (quoteTimeoutRef.current) {
        clearTimeout(quoteTimeoutRef.current);
        quoteTimeoutRef.current = null;
      }
      setToAmountDisplay("");
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }

    quoteTimeoutRef.current = setTimeout(() => {
      quoteTimeoutRef.current = null;
      const requestId = ++quoteRequestIdRef.current;
      const fromDecimals = fromToken!.decimals ?? 18;
      const amountNum = parseFloat(amount);
      const fromAmountRaw = BigInt(
        Math.round(amountNum * Math.pow(10, fromDecimals))
      ).toString();
      const fromTokenAddress =
        fromToken!.tokenAddress ?? NATIVE_TOKEN_ADDRESS;
      const toDecimals = toToken!.decimals ?? 18;
      const toAddressParam =
        destinationSameAsSource || !toAddress.trim()
          ? undefined
          : toAddress.trim();

      setQuoteLoading(true);
      setQuoteError(null);

      fetchLifiQuote({
        fromChainId: LIFI_BASE_CHAIN_ID,
        toChainId: toChain!.id,
        fromTokenAddress,
        toTokenAddress: toToken!.address,
        fromAmount: fromAmountRaw,
        fromAddress: evmAddress!,
        ...(toAddressParam ? { toAddress: toAddressParam } : {}),
        slippage: 0.005,
      })
        .then((res) => {
          if (requestId !== quoteRequestIdRef.current) return;
          const data = res as {
            estimate?: { toAmount?: string; toAmountMin?: string };
          };
          const raw = data?.estimate?.toAmount ?? data?.estimate?.toAmountMin ?? "0";
          const big = BigInt(raw);
          const divisor = BigInt(10) ** BigInt(toDecimals);
          const whole = big / divisor;
          const frac = big % divisor;
          const fracStr = frac.toString().padStart(toDecimals, "0").slice(0, toDecimals);
          const display =
            fracStr === "0".repeat(fracStr.length)
              ? whole.toString()
              : `${whole}.${fracStr.replace(/0+$/, "")}`;
          setToAmountDisplay(display);
          setQuoteError(null);
        })
        .catch((err) => {
          if (requestId !== quoteRequestIdRef.current) return;
          setQuoteError(err instanceof Error ? err.message : "Quote failed");
          setToAmountDisplay("—");
        })
        .finally(() => {
          if (requestId === quoteRequestIdRef.current) setQuoteLoading(false);
        });
    }, 1000);

    return () => {
      if (quoteTimeoutRef.current) {
        clearTimeout(quoteTimeoutRef.current);
        quoteTimeoutRef.current = null;
      }
    };
  }, [
    amount,
    fromToken,
    toChain,
    toToken,
    evmAddress,
    destinationSameAsSource,
    toAddress,
  ]);

  const selectFromToken = useCallback((item: FromTokenOption) => {
    setFromToken(item);
  }, []);

  const selectToChain = useCallback((chain: LifiChain) => {
    setToChain(chain);
    setToToken(null);
    if (chain.id === LIFI_SUI_CHAIN_ID || chain.id === LIFI_SOLANA_CHAIN_ID) {
      setDestinationSameAsSource(false);
    }
    setToDrawerStep("token");
  }, []);

  const selectToToken = useCallback((token: LifiToken) => {
    setToToken(token);
    setTokenSearchQuery("");
    setToDrawerVisible(false);
  }, []);

  const closeToDrawer = useCallback(() => {
    setToDrawerVisible(false);
    setTokenSearchQuery("");
  }, []);

  const handleSwap = useCallback(async () => {
    if (
      !fromToken ||
      !toChain ||
      !toToken ||
      !amount.trim() ||
      !evmAddress ||
      (isToChainSuiOrSolana && !toAddress.trim())
    ) {
      return;
    }
    if (toChain.id === LIFI_BASE_CHAIN_ID && (fromToken.tokenAddress ?? NATIVE_TOKEN_ADDRESS).toLowerCase() === toToken.address.toLowerCase()) {
      setSwapError("Choose a different token or chain.");
      return;
    }
    const provider = await (embeddedEthWallet as { getProvider?: () => Promise<{ request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }> })?.getProvider?.();
    if (!provider) {
      setSwapError("Wallet not connected");
      return;
    }
    const chainIdHex = currentNetwork.evmChainId;
    if (!chainIdHex) {
      setSwapError("Base network not configured");
      return;
    }
    setSwapError(null);
    setSwapSuccess(null);
    setSwapLoading(true);
    try {
      const currentChainId = (await provider.request({ method: "eth_chainId" })) as string;
      if (currentChainId !== chainIdHex) {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }],
        });
      }
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts?.[0];
      if (!from) {
        throw new Error("No account found");
      }
      const fromDecimals = fromToken.decimals ?? 18;
      const amountNum = parseFloat(amount);
      const fromAmountRaw = BigInt(
        Math.round(amountNum * Math.pow(10, fromDecimals))
      ).toString();
      const fromTokenAddress = fromToken.tokenAddress ?? NATIVE_TOKEN_ADDRESS;
      const toAddressParam =
        destinationSameAsSource || !toAddress.trim() ? undefined : toAddress.trim();

      const quoteResult = (await fetchLifiQuote({
        fromChainId: LIFI_BASE_CHAIN_ID,
        toChainId: toChain.id,
        fromTokenAddress,
        toTokenAddress: toToken.address,
        fromAmount: fromAmountRaw,
        fromAddress: evmAddress,
        ...(toAddressParam ? { toAddress: toAddressParam } : {}),
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

      const txRequest = quoteResult?.transactionRequest;
      if (!txRequest?.to || !txRequest?.data) {
        throw new Error("No route returned. Try a different amount or token.");
      }

      const isErc20 = fromToken.tokenAddress != null;
      const approvalAddress = quoteResult?.estimate?.approvalAddress;
      if (isErc20 && approvalAddress) {
        const pad64 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
        const amountHex = BigInt(fromAmountRaw).toString(16);
        const approveData = "0x095ea7b3" + pad64(approvalAddress) + pad64(amountHex);
        await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from,
              to: fromToken.tokenAddress,
              data: approveData,
              value: "0x0",
              gasLimit: "0xfde8",
              chainId: chainIdHex,
            },
          ],
        });
        await new Promise((r) => setTimeout(r, 3000));
      }

      const tx: Record<string, string> = {
        from,
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value ?? "0x0",
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
      setSwapSuccess(`Transaction submitted. Tx: ${hashStr}`);
      setAmount("");
      setToAmountDisplay("");
      refetchBalances();
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : "Swap failed");
    } finally {
      setSwapLoading(false);
    }
  }, [
    fromToken,
    toChain,
    toToken,
    amount,
    evmAddress,
    destinationSameAsSource,
    toAddress,
    isToChainSuiOrSolana,
    embeddedEthWallet,
    currentNetwork.evmChainId,
    refetchBalances,
  ]);

  if (!isBase) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.title}>Swap / Bridge</Text>
        <Text style={[styles.muted, { color: colors.tabIconDefault, marginTop: 8, fontSize: 14 }]}>
          Swap and bridge is only available on Base.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>Swap</Text>
      </View>

      {!evmAddress ? (
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.tabIconDefault + "40" }]}>
          <Text style={[styles.muted, { color: colors.tabIconDefault }]}>
            Connect your Base wallet (Privy) to continue.
          </Text>
        </View>
      ) : (
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: "#444" }]}>
          {/* From box — wraps entire From section */}
          <View style={[styles.fromBox, { borderColor: "#888888" }]}>
          <View style={styles.block}>
            <View style={styles.blockHeader}>
              <Text style={[styles.blockLabel, { color: colors.tabIconDefault }]}>From</Text>
              <View style={styles.walletRow}>
                <Image source={{ uri: BASE_CHAIN_LOGO_URI }} style={styles.walletChainIcon} />
                <Text style={[styles.walletAddress, { color: colors.tabIconDefault }]}>
                  {evmAddress ? truncateAddress(evmAddress) : ""}
                </Text>
                <FontAwesome name="chevron-down" size={12} color={colors.tabIconDefault} />
              </View>
            </View>
            <View style={styles.amountRow}>
              <TextInput
                style={[
                  styles.amountInput,
                  { color: colors.text, opacity: fromToken ? 1 : 0.6 },
                ]}
                placeholder="0.00"
                placeholderTextColor={colors.tabIconDefault}
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                editable={!!fromToken}
              />
              {/* From chain name (fixed Base) */}
              {!baseChain && chainsLoading ? (
                <View style={[styles.chainNameNextToAmount, styles.chainIconLoader]}>
                  <ActivityIndicator size="small" color={colors.tint} />
                </View>
              ) : (
                <Text style={[styles.chainNameNextToAmount, { color: colors.tabIconDefault }]}>Base</Text>
              )}
            </View>
            <View style={styles.tokenRowBlock}>
              <View style={styles.fromTokenSelector}>
                {balanceLoading ? (
                  <ActivityIndicator size="small" color={colors.tint} />
                ) : (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.fromTokenChips}
                  >
                    {baseBalances.map((item) => {
                      const isSelected = fromToken !== null && addressEq(fromToken.tokenAddress, item.tokenAddress);
                      const logoUri = fromToken === item ? (fromTokenLifiDetail?.logoURI ?? item.lifiToken?.logoURI) : undefined;
                      return (
                        <Pressable
                          key={item.tokenAddress ?? "native"}
                          onPress={() => selectFromToken(item)}
                          style={[
                            styles.fromTokenChip,
                            {
                              borderColor: isSelected ? colors.tint : "#888888",
                              borderWidth: isSelected ? 1.5 : 1,
                              ...(isSelected && { backgroundColor: colors.tint + "20" }),
                            },
                          ]}
                        >
                          {logoUri ? (
                            <Image source={{ uri: logoUri }} style={styles.tokenLogoSmall} />
                          ) : null}
                          <Text style={[styles.tokenSymbol, { color: colors.text }]}>{item.symbol}</Text>
                          {!baseChain && chainsLoading ? (
                            <ActivityIndicator size="small" color={colors.tint} />
                          ) : (
                            <Text style={[styles.chainNameInChip, { color: colors.tabIconDefault }]}>Base</Text>
                          )}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
              <Text style={[styles.balLabelHighlight, { color: colors.tint }]}>
                Bal: {fromToken ? fromToken.formatted : "0"}
              </Text>
            </View>
            {balanceError ? (
              <Text style={[styles.muted, { color: "#ef4444", marginTop: 4 }]}>{balanceError}</Text>
            ) : null}
          </View>
          </View>

          {/* Swap direction indicator (non-interactive: from is always Base) */}
          <View
            style={[styles.swapDirectionBtn, { backgroundColor: colors.tabIconDefault + "30" }]}
          >
            <FontAwesome name="chevron-down" size={16} color={colors.text} />
            <FontAwesome name="chevron-down" size={16} color={colors.text} style={{ marginTop: -10 }} />
          </View>

          {/* To box — wraps entire To section */}
          <View style={[styles.toBox, { borderColor: "#888888" }]}>
          <View style={styles.block}>
            <View style={styles.blockHeader}>
              <Text style={[styles.blockLabel, { color: colors.tabIconDefault }]}>To</Text>
            </View>
            <View style={styles.amountRow}>
              <View style={[styles.amountPlaceholder, { borderBottomWidth: 0, flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }]}>
                {quoteLoading ? (
                  <ActivityIndicator size="small" color={colors.tint} />
                ) : null}
                <Text
                  style={[
                    styles.amountInput,
                    { color: quoteLoading ? colors.tabIconDefault : colors.text },
                  ]}
                  numberOfLines={1}
                >
                  {quoteLoading ? "…" : toAmountDisplay || "0.00"}
                </Text>
              </View>
              <Pressable
                style={[
                  styles.chainSelectorInAmountRow,
                  {
                    borderWidth: 2,
                    borderRadius: 8,
                    borderColor: "#888888",
                    paddingVertical: 5,
                    paddingHorizontal: 8,
                  },
                ]}
                onPress={() => {
                  setToDrawerStep("chain");
                  setToDrawerVisible(true);
                }}
              >
                {toChain ? (
                  <Text
                    style={[styles.chainNameNextToAmount, { color: colors.tabIconDefault }]}
                    numberOfLines={1}
                  >
                    {toChain.name}
                  </Text>
                ) : (
                  <>
                    <Text style={[styles.chainNameNextToAmount, { color: colors.tabIconDefault }]}>
                      Select chain
                    </Text>
                    <FontAwesome name="chevron-down" size={12} color={colors.tabIconDefault} style={{ marginLeft: 4 }} />
                  </>
                )}
              </Pressable>
            </View>
            {quoteError ? (
              <Text style={[styles.muted, { color: "#ef4444", marginTop: 4 }]} numberOfLines={2}>
                {quoteError}
              </Text>
            ) : null}
            <View style={styles.tokenRowBlock}>
              {toChain ? (
                <Pressable
                  style={[
                    styles.toSelectorWrap,
                    !toToken && styles.emptyDropdown,
                    { borderColor: "#888888", borderWidth: 2 },
                  ]}
                  onPress={() => {
                    setToDrawerStep("token");
                    setToDrawerVisible(true);
                  }}
                >
                  {toToken ? (
                    <View style={styles.selectedToToken}>
                      {toToken.logoURI ? (
                        <Image source={{ uri: toToken.logoURI }} style={styles.tokenLogoInSelector} />
                      ) : null}
                      <View style={styles.toTokenSymbolWrap}>
                        <Text style={[styles.toSelectorTokenText, { color: colors.text }]}>{toToken.symbol}</Text>
                        <Text style={[styles.toSelectorChainText, { color: colors.tabIconDefault }]} numberOfLines={1}>
                          {toChain.name}
                        </Text>
                      </View>
                      <FontAwesome name="chevron-down" size={10} color={colors.tabIconDefault} />
                    </View>
                  ) : (
                    <View style={styles.emptyDropdownContent}>
                      <Text style={[styles.toSelectorPlaceholder, { color: colors.tabIconDefault }]}>
                        Select token
                      </Text>
                      <FontAwesome name="chevron-down" size={10} color={colors.tabIconDefault} />
                    </View>
                  )}
                </Pressable>
              ) : (
                <View style={styles.toSelectorSpacer} />
              )}
            </View>
          </View>

          {/* Destination address: for Sui/Solana always show field (no "same as source"); for EVM show checkbox + optional field */}
          {!isToChainSuiOrSolana ? (
            <Pressable
              style={[
                styles.destinationCheckRow,
                { borderTopColor: "#666666", borderColor: "#888888" },
              ]}
              onPress={() => setDestinationSameAsSource((v) => !v)}
            >
              <FontAwesome
                name={destinationSameAsSource ? "check-square" : "square-o"}
                size={20}
                color={destinationSameAsSource ? colors.tint : colors.tabIconDefault}
              />
              <Text style={[styles.destinationCheckLabel, { color: colors.text }]}>
                Destination address same as source
              </Text>
            </Pressable>
          ) : null}
          {(isToChainSuiOrSolana || !destinationSameAsSource) ? (
            <View
              style={[
                styles.toAddressFieldWrap,
                { borderColor: "#888888", borderWidth: 2 },
              ]}
            >
              <TextInput
                style={[styles.toAddressInput, { color: colors.text }]}
                placeholder={
                  isToChainSuiOrSolana
                    ? "Destination address"
                    : "Destination address (0x...)"
                }
                placeholderTextColor={colors.tabIconDefault}
                value={toAddress}
                onChangeText={setToAddress}
                autoCapitalize="none"
                autoCorrect={false}
                underlineColorAndroid="transparent"
              />
            </View>
          ) : null}
          </View>

          {isSameTokenSameNetwork ? (
            <Text style={[styles.muted, { color: colors.tabIconDefault, marginTop: 8 }]}>
              Choose a different token or chain.
            </Text>
          ) : null}
          {swapError ? (
            <Text style={[styles.muted, { color: "#ef4444", marginTop: 8 }]} numberOfLines={2}>
              {swapError}
            </Text>
          ) : null}
          {swapSuccess ? (
            <Text style={[styles.muted, { color: "#22c55e", marginTop: 8 }]} numberOfLines={3}>
              {swapSuccess}
            </Text>
          ) : null}
          <Pressable
            style={[
              styles.primaryButton,
              {
                backgroundColor:
                  fromToken && toChain && toToken && amount.trim() && !swapLoading && !isSameTokenSameNetwork
                    ? colors.tint
                    : "#555555",
                borderWidth: 2,
                borderColor:
                  fromToken && toChain && toToken && amount.trim() && !swapLoading && !isSameTokenSameNetwork
                    ? colors.tint
                    : "#666666",
              },
            ]}
            onPress={handleSwap}
            disabled={
              !fromToken ||
              !toChain ||
              !toToken ||
              !amount.trim() ||
              (!!isToChainSuiOrSolana && !toAddress.trim()) ||
              swapLoading ||
              isSameTokenSameNetwork
            }
          >
            {swapLoading ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.primaryButtonText, { color: colors.background }]}>
                {toChain?.id === LIFI_BASE_CHAIN_ID ? "Swap" : "Bridge"}
              </Text>
            )}
          </Pressable>
        </View>
      )}

      {/* To section: drawer menu (chain list → token list) */}
      <Modal
        visible={toDrawerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setToDrawerVisible(false)}
      >
        <Pressable
          style={styles.drawerOverlay}
          onPress={closeToDrawer}
        >
          <Pressable
            style={[styles.drawerContent, { backgroundColor: colors.background }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={[styles.drawerHandle, { backgroundColor: colors.tabIconDefault + "60" }]} />
            <View style={styles.drawerHeader}>
              {toDrawerStep === "chain" ? (
                <Text style={[styles.modalTitle, { color: colors.text }]}>Select chain</Text>
              ) : (
                <View>
                  <Text style={[styles.modalTitle, { color: colors.text }]}>
                    Select token {toChain ? `on ${toChain.name}` : ""}
                  </Text>
                  <Pressable
                    onPress={() => {
                      setToDrawerStep("chain");
                      setTokenSearchQuery("");
                    }}
                    hitSlop={8}
                    style={{ marginTop: 4 }}
                  >
                    <Text style={[styles.changeChainLink, { color: colors.tint }]}>Change chain</Text>
                  </Pressable>
                </View>
              )}
              <Pressable onPress={closeToDrawer} hitSlop={12}>
                <Text style={[styles.modalClose, { color: colors.tint }]}>Done</Text>
              </Pressable>
            </View>
            {toDrawerStep === "chain" ? (
              <ScrollView style={styles.modalScroll}>
                {chainsLoading ? (
                  <View style={styles.modalLoading}>
                    <ActivityIndicator size="large" color={colors.tint} />
                    <Text style={[styles.muted, { color: colors.tabIconDefault, marginTop: 12 }]}>
                      Loading chains…
                    </Text>
                  </View>
                ) : (
                  chains.map((chain) => (
                    <Pressable
                      key={chain.id}
                      style={[styles.chainRow, { borderColor: colors.tabIconDefault + "40" }]}
                      onPress={() => selectToChain(chain)}
                    >
                      <Text style={[styles.chainRowName, { color: colors.text }]}>
                        {chain.name}
                      </Text>
                      <Text style={[styles.chainRowCoin, { color: colors.tabIconDefault }]}>
                        {chain.coin}
                      </Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            ) : (
              <>
                <View style={[styles.tokenSearchRow, { borderColor: colors.tabIconDefault + "40" }]}>
                  <FontAwesome name="search" size={14} color={colors.tabIconDefault} />
                  <TextInput
                    style={[styles.tokenSearchInput, { color: colors.text }]}
                    placeholder="Search by symbol or name"
                    placeholderTextColor={colors.tabIconDefault}
                    value={tokenSearchQuery}
                    onChangeText={setTokenSearchQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {tokenSearchQuery.length > 0 ? (
                    <Pressable onPress={() => setTokenSearchQuery("")} hitSlop={8}>
                      <FontAwesome name="times-circle" size={16} color={colors.tabIconDefault} />
                    </Pressable>
                  ) : null}
                </View>
                <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
                  {tokensLoading ? (
                    <View style={styles.modalLoading}>
                      <ActivityIndicator size="large" color={colors.tint} />
                      <Text style={[styles.muted, { color: colors.tabIconDefault, marginTop: 12 }]}>
                        Loading tokens…
                      </Text>
                    </View>
                  ) : selectableToTokens.length === 0 ? (
                    <View style={styles.modalLoading}>
                      <Text style={[styles.muted, { color: colors.tabIconDefault }]}>
                        {toTokens.length === 0
                          ? "No tokens"
                          : `No tokens matching "${tokenSearchQuery}"`}
                      </Text>
                    </View>
                  ) : (
                    selectableToTokens.map((token) => (
                    <Pressable
                      key={`${token.chainId}-${token.address}`}
                      style={[styles.chainRow, { borderColor: colors.tabIconDefault + "40" }]}
                      onPress={() => selectToToken(token)}
                    >
                      {token.logoURI ? (
                        <Image source={{ uri: token.logoURI }} style={styles.chainLogoMedium} />
                      ) : null}
                      <View style={styles.tokenInfo}>
                        <Text style={[styles.chainRowName, { color: colors.text }]}>
                          {token.symbol}
                        </Text>
                        <Text style={[styles.chainRowCoin, { color: colors.tabIconDefault }]} numberOfLines={1}>
                          {token.name}
                        </Text>
                      </View>
                      {token.priceUSD ? (
                        <Text style={[styles.priceUsd, { color: colors.tabIconDefault }]}>
                          ${token.priceUSD}
                        </Text>
                      ) : null}
                    </Pressable>
                  ))
                  )}
                </ScrollView>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  titleRow: {
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
  },
  card: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    marginBottom: 16,
  },
  fromBox: {
    borderRadius: 14,
    borderWidth: 2,
    padding: 14,
    marginBottom: 12,
  },
  toBox: {
    borderRadius: 14,
    borderWidth: 2,
    padding: 14,
    marginBottom: 16,
  },
  block: {
    marginBottom: 4,
  },
  blockHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  blockLabel: {
    fontSize: 13,
    fontWeight: "500",
  },
  walletRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  walletChainIcon: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  walletAddress: {
    fontSize: 12,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  amountInput: {
    fontSize: 32,
    fontWeight: "600",
    paddingVertical: 4,
    flex: 1,
  },
  chainIconNextToAmount: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginLeft: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  chainNameNextToAmount: {
    fontSize: 15,
    fontWeight: "600",
    marginLeft: 12,
    alignSelf: "center",
  },
  chainSelectorInAmountRow: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 12,
  },
  chainIconLoader: {
    backgroundColor: "transparent",
  },
  tokenRowBlock: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    gap: 12,
  },
  fromTokenSelector: {
    flex: 1,
  },
  fromTokenChips: {
    flexDirection: "row",
    gap: 8,
  },
  fromTokenChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  tokenLogoSmall: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  tokenSymbol: {
    fontSize: 15,
    fontWeight: "600",
  },
  chainNameInChip: {
    fontSize: 11,
    fontWeight: "500",
  },
  toTokenSymbolWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  tokenLogoInSelector: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  toSelectorTokenText: {
    fontSize: 13,
    fontWeight: "600",
  },
  toSelectorChainText: {
    fontSize: 11,
    fontWeight: "500",
  },
  toSelectorPlaceholder: {
    fontSize: 13,
    fontWeight: "500",
  },
  balLabel: {
    fontSize: 12,
  },
  balLabelHighlight: {
    fontSize: 15,
    fontWeight: "700",
    minWidth: 72,
    textAlign: "right",
  },
  swapDirectionBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginVertical: 8,
  },
  amountPlaceholder: {
    paddingVertical: 4,
    marginBottom: 4,
  },
  toSelectorWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 40,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  emptyDropdown: {
    backgroundColor: "transparent",
  },
  toSelectorSpacer: {
    flex: 1,
  },
  emptyDropdownContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  selectedToToken: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  selectTokenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  selectTokenText: {
    fontSize: 15,
    fontWeight: "500",
  },
  destinationCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginTop: 8,
    borderTopWidth: 1,
    borderRadius: 12,
    borderWidth: 1,
  },
  destinationCheckLabel: {
    flex: 1,
    fontSize: 14,
  },
  toAddressFieldWrap: {
    marginTop: 8,
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 2,
  },
  toAddressInput: {
    fontSize: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  primaryButton: {
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 16,
  },
  primaryButtonText: {
    fontSize: 17,
    fontWeight: "600",
  },
  muted: {
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "70%",
    paddingBottom: 34,
  },
  drawerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  drawerContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "75%",
    paddingBottom: 34,
    paddingTop: 8,
  },
  drawerHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 16,
  },
  drawerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(128,128,128,0.3)",
  },
  tokenSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  tokenSearchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 4,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(128,128,128,0.3)",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  modalClose: {
    fontSize: 16,
    fontWeight: "600",
  },
  changeChainLink: {
    fontSize: 13,
  },
  modalScroll: {
    maxHeight: 400,
    padding: 16,
  },
  modalLoading: {
    paddingVertical: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  chainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
  },
  chainLogoMedium: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  chainRowName: {
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
  },
  chainRowCoin: {
    fontSize: 12,
  },
  tokenInfo: {
    flex: 1,
  },
  priceUsd: {
    fontSize: 12,
  },
});
