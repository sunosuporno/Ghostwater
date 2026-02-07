import { Text } from "@/components/Themed";
import { Redirect, useRouter } from "expo-router";
import { useMemo, useRef } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { useTicker } from "@/hooks/useDeepBookMargin";
import { useNetwork } from "@/lib/network";

const PRICE_POLL_MS = 5000;

/** Sui margin-enabled pool keys (same as trading tab). */
const MARGIN_ENABLED_PAIRS = new Set(["SUI_USDC", "WAL_USDC", "DEEP_USDC"]);

function formatPairLabel(poolName: string): string {
  return poolName.replace("_", "/");
}

/**
 * Pools tab: visible only on Base. Shows Sui DeepBook margin pools so users can
 * choose a pool and (later) start "Deposit from Base into margin" flow.
 */
export default function PoolsScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentNetwork } = useNetwork();
  const { ticker, loading, error } = useTicker(PRICE_POLL_MS);

  // Pools tab is a Base-mainnet-only capability; redirect to Home if not enabled.
  if (!currentNetwork.capabilities.showPoolsTab) {
    return <Redirect href="/(app)" />;
  }
  const prevPricesRef = useRef<Record<string, number>>({});
  const lastDirectionRef = useRef<Record<string, "up" | "down">>({});

  // Only show margin-enabled pools (same as Margin tab on Sui).
  const pairs = useMemo(() => {
    const entries = Object.entries(ticker).filter(([, v]) => v?.isFrozen === 0);
    return entries
      .map(([name, data]) => ({ poolName: name, lastPrice: data.last_price }))
      .filter(
        (p) =>
          MARGIN_ENABLED_PAIRS.has(p.poolName) &&
          typeof p.lastPrice === "number" &&
          p.lastPrice > 0
      )
      .sort((a, b) => a.poolName.localeCompare(b.poolName));
  }, [ticker]);

  // Open same trading pair detail as Margin tab; pass from=pools so back returns to Pools list.
  const onPressPair = (poolName: string) => {
    router.push(
      `/(app)/trading/${encodeURIComponent(poolName)}?from=pools` as const
    );
  };

  if (loading && pairs.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={styles.muted}>Loading margin pools…</Text>
      </View>
    );
  }

  if (error && pairs.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  const listHeader = (
    <View style={[styles.header, { paddingTop: insets.top + 24 }]}>
      <Text style={[styles.title, { color: colors.text }]}>
        Sui margin pools
      </Text>
      <Text style={[styles.subtitle, { color: colors.text }]}>
        Deposit from Base into a pool to trade with margin on Sui.
      </Text>
    </View>
  );

  return (
    <FlatList
      data={pairs}
      keyExtractor={(item) => item.poolName}
      contentContainerStyle={styles.list}
      ListHeaderComponent={listHeader}
      ListEmptyComponent={
        <View style={styles.centered}>
          <Text style={styles.muted}>No margin pools available.</Text>
        </View>
      }
      renderItem={({ item }) => {
        const currentPrice = item.lastPrice;
        const prevPrice = prevPricesRef.current[item.poolName];
        let direction: "up" | "down" | null = null;
        if (typeof currentPrice === "number") {
          if (prevPrice === undefined) {
            direction = null;
          } else if (currentPrice > prevPrice) {
            direction = "up";
            lastDirectionRef.current[item.poolName] = "up";
          } else if (currentPrice < prevPrice) {
            direction = "down";
            lastDirectionRef.current[item.poolName] = "down";
          } else {
            direction = lastDirectionRef.current[item.poolName] ?? null;
          }
          prevPricesRef.current[item.poolName] = currentPrice;
        }
        const priceText =
          typeof currentPrice === "number"
            ? currentPrice.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 6,
              })
            : "—";
        return (
          <Pressable
            onPress={() => onPressPair(item.poolName)}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: colors.background,
                borderColor: colors.tabIconDefault + "40",
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <View style={styles.pairLabelRow}>
              <Text style={[styles.pairLabel, { color: colors.text }]}>
                {formatPairLabel(item.poolName)}
              </Text>
            </View>
            <View style={styles.priceWithArrow}>
              {direction === "up" && (
                <Text
                  style={[styles.priceArrow, styles.priceUp]}
                  allowFontScaling={false}
                >
                  ▲
                </Text>
              )}
              {direction === "down" && (
                <Text
                  style={[styles.priceArrow, styles.priceDown]}
                  allowFontScaling={false}
                >
                  ▼
                </Text>
              )}
              <Text
                style={[
                  styles.price,
                  { color: colors.text },
                  direction === "up" && styles.priceUp,
                  direction === "down" && styles.priceDown,
                ]}
              >
                {priceText}
              </Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  header: {
    paddingHorizontal: 8,
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
  },
  subtitle: {
    fontSize: 15,
    opacity: 0.8,
    marginTop: 8,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  pairLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pairLabel: { fontSize: 17, fontWeight: "600" },
  marginBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  marginBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  priceWithArrow: { flexDirection: "row", alignItems: "center", gap: 6 },
  priceArrow: { fontSize: 12, fontWeight: "700" },
  price: { fontSize: 16, fontWeight: "500" },
  priceUp: { color: "#22c55e" },
  priceDown: { color: "#ef4444" },
  muted: { fontSize: 16, opacity: 0.7 },
  error: { fontSize: 16, color: "#ef4444" },
});
