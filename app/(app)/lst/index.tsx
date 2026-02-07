/**
 * LST (Liquid Staking) — Base only.
 * Flow: stake from Base (ETH or USDC) → Lido wstETH on Ethereum mainnet via LI.FI.
 */

import { useEmbeddedEthereumWallet } from "@privy-io/expo";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
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
import { BASE_MAINNET_CHAIN_ID } from "@/lib/bridge-to-margin-constants";
import {
  ETH_MAINNET_CHAIN_ID,
  LIDO_WSTETH_MAINNET,
} from "@/constants/lido-mainnet";
import {
  fetchLifiQuote,
  fetchLifiStatus,
  type LifiStatusResponse,
} from "@/lib/lifi-quote";
import { useNetwork } from "@/lib/network";
import {
  fetchAllBaseBalances,
  type BaseBalanceItem,
} from "@/lib/base-balance-fetch";

/** Native ETH on EVM (LI.FI convention). */
const NATIVE_ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Match EVM address ignoring case (API may return checksum or lowercase). */
function addressEq(a: string | null, b: string | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
}

const LIFI_SLIPPAGE = 0.005;

/** Link color that reads as clickable in both light and dark mode. */
const LINK_COLOR = "#58a6ff";
const POLL_MS = 6000;
const MAX_POLLS = 50;
const MAX_NOT_FOUND = 10;

type SourceToken = "ETH" | "USDC";

function getTokenAddress(token: SourceToken): string {
  return token === "ETH" ? NATIVE_ETH_ADDRESS : BASE_USDC;
}

function getDecimals(token: SourceToken): number {
  return token === "ETH" ? 18 : 6;
}

export default function LstScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const insets = useSafeAreaInsets();
  const { currentNetwork } = useNetwork();
  const { wallets: embeddedEthWallets } = useEmbeddedEthereumWallet();
  const embeddedEthWallet = embeddedEthWallets?.[0];

  const isBaseMainnet = currentNetwork.id === "base-mainnet";

  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [baseBalances, setBaseBalances] = useState<BaseBalanceItem[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [sourceToken, setSourceToken] = useState<SourceToken>("USDC");
  const [amount, setAmount] = useState("");
  const [amountExceedsBalance, setAmountExceedsBalance] = useState(false);

  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [lifiStatus, setLifiStatus] = useState<LifiStatusResponse | null>(null);

  const refetchBalances = useCallback(() => {
    if (!evmAddress || !isBaseMainnet) {
      setBaseBalances([]);
      setBalanceError(null);
      return;
    }
    setBalanceError(null);
    setBalanceLoading(true);
    fetchAllBaseBalances(evmAddress, "base-mainnet")
      .then(setBaseBalances)
      .catch((err) => {
        setBalanceError(
          err instanceof Error ? err.message : "Failed to load balances"
        );
        setBaseBalances([]);
      })
      .finally(() => setBalanceLoading(false));
  }, [evmAddress, isBaseMainnet]);

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
    if (!evmAddress || !isBaseMainnet) return;
    refetchBalances();
  }, [evmAddress, isBaseMainnet, refetchBalances]);

  // Validate amount vs balance
  useEffect(() => {
    const raw = amount.trim();
    if (!raw || !evmAddress) {
      setAmountExceedsBalance(false);
      return;
    }
    const num = parseFloat(raw);
    if (!Number.isFinite(num) || num <= 0) {
      setAmountExceedsBalance(false);
      return;
    }
    const decimals = getDecimals(sourceToken);
    const amountWei = BigInt(Math.floor(num * Math.pow(10, decimals)));
    const item = baseBalances.find(
      (b) =>
        (sourceToken === "ETH" && b.tokenAddress === null) ||
        (sourceToken === "USDC" && addressEq(b.tokenAddress, BASE_USDC))
    );
    const balanceWei = item ? BigInt(item.rawBalance) : BigInt(0);
    setAmountExceedsBalance(amountWei > balanceWei);
  }, [amount, sourceToken, baseBalances, evmAddress]);

  // Poll LI.FI status
  useEffect(() => {
    if (!txHash || !isBaseMainnet) return;
    let notFoundCount = 0;
    let pollCount = 0;

    const poll = async (): Promise<boolean> => {
      try {
        const status = await fetchLifiStatus(txHash!, BASE_MAINNET_CHAIN_ID);
        setLifiStatus(status);
        if (status.status === "NOT_FOUND") {
          notFoundCount += 1;
          if (notFoundCount >= MAX_NOT_FOUND) return true;
        } else {
          notFoundCount = 0;
          if (status.status === "DONE" || status.status === "FAILED") return true;
        }
      } catch {
        // keep polling on network error
      }
      return false;
    };

    const id = setInterval(async () => {
      pollCount += 1;
      if (pollCount > MAX_POLLS) {
        clearInterval(id);
        return;
      }
      const done = await poll();
      if (done) clearInterval(id);
    }, POLL_MS);
    poll();
    return () => clearInterval(id);
  }, [txHash, isBaseMainnet]);

  const handleStake = useCallback(async () => {
    if (!evmAddress?.trim()) {
      setSubmitError("No wallet address");
      return;
    }
    if (!embeddedEthWallet) {
      setSubmitError("No Privy EVM wallet available.");
      return;
    }
    const raw = amount.trim();
    if (!raw) {
      setSubmitError("Enter an amount");
      return;
    }
    const num = parseFloat(raw);
    if (!Number.isFinite(num) || num <= 0) {
      setSubmitError("Enter a valid amount");
      return;
    }
    if (amountExceedsBalance) {
      setSubmitError("Amount exceeds balance");
      return;
    }

    const decimals = getDecimals(sourceToken);
    const fromAmountWei = BigInt(
      Math.floor(num * Math.pow(10, decimals))
    ).toString();
    const fromTokenAddress = getTokenAddress(sourceToken);

    setSubmitError(null);
    setSubmitLoading(true);
    try {
      const provider = await (embeddedEthWallet as any).getProvider();
      const chainIdHex = currentNetwork.evmChainId;
      if (!chainIdHex) {
        throw new Error("Base network not configured for EVM.");
      }
      const currentChainId = (await provider.request({
        method: "eth_chainId",
      })) as string;
      if (currentChainId !== chainIdHex) {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }],
        });
      }
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const from = accounts?.[0];
      if (!from) throw new Error("No account found.");

      const quoteResult = (await fetchLifiQuote({
        fromChainId: BASE_MAINNET_CHAIN_ID,
        toChainId: ETH_MAINNET_CHAIN_ID,
        fromTokenAddress,
        toTokenAddress: LIDO_WSTETH_MAINNET,
        fromAmount: fromAmountWei,
        fromAddress: from,
        toAddress: from,
        slippage: LIFI_SLIPPAGE,
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
        throw new Error(
          "No route returned. Try a different amount or ensure Composer is enabled for this integration."
        );
      }

      // ERC20 approval: when using USDC, LI.FI returns estimate.approvalAddress (the spender).
      // We must approve that address to spend our USDC before the main tx (LiFiDiamond uses transferFrom).
      const isErc20 = sourceToken === "USDC";
      const approvalAddress = quoteResult?.estimate?.approvalAddress;
      if (isErc20 && approvalAddress) {
        const pad64 = (hex: string) =>
          hex.replace(/^0x/, "").padStart(64, "0");
        const amountHex = BigInt(fromAmountWei).toString(16);
        const approveData =
          "0x095ea7b3" + pad64(approvalAddress) + pad64(amountHex);
        await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from,
              to: BASE_USDC,
              data: approveData,
              value: "0x0",
              gasLimit: "0xfde8", // 65000
              chainId: chainIdHex,
            },
          ],
        });
        // Wait for approval to be mined so transferFrom succeeds
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
      if (txRequest.maxPriorityFeePerGas)
        tx.maxPriorityFeePerGas = txRequest.maxPriorityFeePerGas;
      if (txRequest.chainId != null)
        tx.chainId = "0x" + Number(txRequest.chainId).toString(16);

      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [tx],
      });
      const hashStr = String(hash);
      setTxHash(hashStr);
      setLifiStatus(null);
      setAmount("");
      refetchBalances();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Stake request failed";
      setSubmitError(msg);
    } finally {
      setSubmitLoading(false);
    }
  }, [
    evmAddress,
    embeddedEthWallet,
    currentNetwork.evmChainId,
    amount,
    amountExceedsBalance,
    refetchBalances,
  ]);

  const resetFlow = useCallback(() => {
    setTxHash(null);
    setLifiStatus(null);
    setSubmitError(null);
  }, []);

  if (!isBaseMainnet) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.section}>
          <Text style={[styles.title, { color: colors.text }]}>
            Liquid Staking (LST)
          </Text>
          <Text
            style={[styles.muted, { color: colors.tabIconDefault, marginTop: 8 }]}
          >
            Switch to Base in the network selector to stake from Base into Lido
            (wstETH) on Ethereum.
          </Text>
        </View>
      </View>
    );
  }

  const balanceItem = baseBalances.find(
    (b) =>
      (sourceToken === "ETH" && b.tokenAddress === null) ||
      (sourceToken === "USDC" && addressEq(b.tokenAddress, BASE_USDC))
  );
  const balanceFormatted = balanceItem?.formatted ?? "0";

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.section}>
        <Text style={[styles.title, { color: colors.text }]}>
          Liquid Staking
        </Text>
        <Text
          style={[styles.muted, { color: colors.tabIconDefault, marginTop: 4 }]}
        >
          Stake from Base → Lido (wstETH) on Ethereum in one step.
        </Text>
      </View>

      {!evmAddress ? (
        <View style={styles.section}>
          <Text style={[styles.muted, { color: colors.tabIconDefault }]}>
            Connect your Base wallet (Privy) to continue.
          </Text>
        </View>
      ) : (
        <>
          <View style={[styles.section, styles.card, { backgroundColor: colors.background, borderColor: colors.tabIconDefault + "40" }]}>
            <Text style={[styles.label, { color: colors.text }]}>From (Base)</Text>
            <View style={styles.row}>
              <Pressable
                onPress={() => setSourceToken("ETH")}
                style={[
                  styles.tokenChip,
                  sourceToken === "ETH" && { backgroundColor: colors.tint + "30", borderColor: colors.tint },
                ]}
              >
                <Text style={[styles.tokenChipText, { color: colors.text }]}>ETH</Text>
              </Pressable>
              <Pressable
                onPress={() => setSourceToken("USDC")}
                style={[
                  styles.tokenChip,
                  sourceToken === "USDC" && { backgroundColor: colors.tint + "30", borderColor: colors.tint },
                ]}
              >
                <Text style={[styles.tokenChipText, { color: colors.text }]}>USDC</Text>
              </Pressable>
            </View>
            <Text style={[styles.muted, { color: colors.tabIconDefault, marginTop: 4 }]}>
              Balance: {balanceLoading ? "…" : balanceFormatted} {sourceToken}
            </Text>
            {balanceError ? (
              <Text style={[styles.muted, { color: "#ef4444", marginTop: 4 }]}>
                {balanceError}
              </Text>
            ) : null}
          </View>

          <View style={[styles.section, styles.card, { backgroundColor: colors.background, borderColor: colors.tabIconDefault + "40" }]}>
            <Text style={[styles.label, { color: colors.text }]}>Amount</Text>
            <TextInput
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.tabIconDefault + "60" },
                amountExceedsBalance && { borderColor: "#ef4444" },
              ]}
              placeholder="0"
              placeholderTextColor={colors.tabIconDefault}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              editable={
                !submitLoading &&
                (!txHash ||
                  lifiStatus?.status === "DONE" ||
                  lifiStatus?.status === "FAILED")
              }
            />
            {amountExceedsBalance ? (
              <Text style={[styles.muted, { color: "#ef4444", marginTop: 4 }]}>
                Amount exceeds balance
              </Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={[styles.muted, { color: colors.tabIconDefault, fontSize: 12 }]}>
              To: Lido wstETH on Ethereum (same address as your Base wallet).
            </Text>
          </View>

          {submitError ? (
            <View style={[styles.section, styles.errorBox]}>
              <Text style={styles.errorText}>{submitError}</Text>
            </View>
          ) : null}

          {txHash && lifiStatus ? (
            <View style={[styles.section, styles.card, { backgroundColor: colors.background, borderColor: colors.tabIconDefault + "40" }]}>
              {/* Status alert — full width, clear hierarchy */}
              <View
                style={[
                  styles.statusBanner,
                  {
                    backgroundColor:
                      lifiStatus.status === "DONE"
                        ? "#22c55e18"
                        : lifiStatus.status === "FAILED"
                          ? "#ef444418"
                          : "#eab30818",
                    borderColor:
                      lifiStatus.status === "DONE"
                        ? "#22c55e"
                        : lifiStatus.status === "FAILED"
                          ? "#ef4444"
                          : "#eab308",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.statusBannerTitle,
                    {
                      color:
                        lifiStatus.status === "DONE"
                          ? "#22c55e"
                          : lifiStatus.status === "FAILED"
                            ? "#ef4444"
                            : "#eab308",
                    },
                  ]}
                >
                  {lifiStatus.status === "PENDING"
                    ? "Bridging & staking…"
                    : lifiStatus.status === "DONE"
                      ? "Complete"
                      : lifiStatus.status === "FAILED"
                        ? "Failed"
                        : lifiStatus.status}
                </Text>
                {lifiStatus.status === "FAILED" && (
                  <Text style={[styles.statusBannerSubtext, { color: colors.tabIconDefault }]}>
                    The transfer did not complete. You can try again below.
                  </Text>
                )}
                {lifiStatus.substatusMessage != null &&
                  lifiStatus.status === "PENDING" && (
                    <Text
                      style={[styles.statusBannerSubtext, { color: colors.text }]}
                      numberOfLines={2}
                    >
                      {lifiStatus.substatusMessage}
                    </Text>
                  )}
              </View>

              {/* Links — labeled section, aligned list */}
              <Text style={[styles.linksLabel, { color: colors.tabIconDefault }]}>
                Transaction links
              </Text>
              <View style={styles.linksList}>
                {lifiStatus.sending?.txLink ? (
                  <Pressable
                    onPress={() =>
                      lifiStatus.sending?.txLink &&
                      Linking.openURL(lifiStatus.sending.txLink)
                    }
                    style={({ pressed }) => [
                      styles.linkRow,
                      { opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Text style={styles.linkTextStyled}>Source tx</Text>
                  </Pressable>
                ) : null}
                {lifiStatus.receiving?.txLink ? (
                  <Pressable
                    onPress={() =>
                      lifiStatus.receiving?.txLink &&
                      Linking.openURL(lifiStatus.receiving.txLink)
                    }
                    style={({ pressed }) => [
                      styles.linkRow,
                      { opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Text style={styles.linkTextStyled}>Destination tx</Text>
                  </Pressable>
                ) : null}
                {lifiStatus.lifiExplorerLink ? (
                  <Pressable
                    onPress={() =>
                      lifiStatus?.lifiExplorerLink &&
                      Linking.openURL(lifiStatus.lifiExplorerLink)
                    }
                    style={({ pressed }) => [
                      styles.linkRow,
                      { opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Text style={styles.linkTextStyled}>Track on LI.FI</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* CTA — full-width button when done or failed */}
              {(lifiStatus.status === "DONE" || lifiStatus.status === "FAILED") && (
                <Pressable
                  onPress={resetFlow}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    {
                      marginTop: 20,
                      backgroundColor: lifiStatus.status === "FAILED" ? "#ef4444" : colors.tint,
                      opacity: pressed ? 0.9 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.primaryButtonText, { color: "#fff" }]}>
                    Stake again
                  </Text>
                </Pressable>
              )}
            </View>
          ) : txHash ? (
            <View style={[styles.section, styles.card, { backgroundColor: colors.background, borderColor: colors.tabIconDefault + "40" }]}>
              <View style={[styles.statusBadge, { backgroundColor: "#eab30822", borderColor: "#eab308" }]}>
                <Text style={[styles.statusBadgeText, { color: "#eab308" }]}>
                  Checking…
                </Text>
              </View>
              <Pressable
                onPress={() => Linking.openURL(`https://scan.li.fi/tx/${txHash}`)}
                style={({ pressed }) => [
                  styles.linkRow,
                  { marginTop: 12, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={styles.linkTextStyled}>Track on LI.FI</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.section}>
              <Pressable
                onPress={handleStake}
                disabled={
                  submitLoading ||
                  !amount.trim() ||
                  amountExceedsBalance ||
                  parseFloat(amount.trim()) <= 0
                }
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: colors.tint,
                    opacity:
                      submitLoading ||
                      !amount.trim() ||
                      amountExceedsBalance ||
                      parseFloat(amount.trim()) <= 0
                        ? 0.5
                        : pressed
                          ? 0.9
                          : 1,
                  },
                ]}
              >
                {submitLoading ? (
                  <ActivityIndicator
                    color={colorScheme === "dark" ? "#000" : "#fff"}
                  />
                ) : (
                  <Text
                    style={[
                      styles.primaryButtonText,
                      { color: colorScheme === "dark" ? "#000" : "#fff" },
                    ]}
                  >
                    Stake to Lido
                  </Text>
                )}
              </Pressable>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
  },
  section: {
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 6,
  },
  muted: {
    fontSize: 13,
    opacity: 0.9,
  },
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  row: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  tokenChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "transparent",
  },
  tokenChipText: {
    fontSize: 15,
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
  },
  errorBox: {
    backgroundColor: "#ef444422",
    padding: 12,
    borderRadius: 10,
  },
  errorText: {
    color: "#ef4444",
    fontSize: 14,
  },
  statusBanner: {
    width: "100%",
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusBannerTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  statusBannerSubtext: {
    fontSize: 13,
    marginTop: 6,
    opacity: 0.9,
  },
  linksLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginTop: 16,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  linksList: {
    gap: 4,
  },
  linkRow: {
    paddingVertical: 10,
    paddingHorizontal: 0,
  },
  linkText: {
    fontSize: 15,
    fontWeight: "500",
  },
  linkTextStyled: {
    fontSize: 15,
    fontWeight: "600",
    color: LINK_COLOR,
    textDecorationLine: "underline",
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  statusBadgeText: {
    fontSize: 14,
    fontWeight: "600",
  },
  linksRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 10,
  },
  link: {
    paddingVertical: 4,
  },
  primaryButton: {
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "600",
  },
  secondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: "flex-start",
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "500",
  },
});
