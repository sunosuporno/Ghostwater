/**
 * Single pool list: tap tab → list, tap item → open pool.
 * Used by both Base (Deepbook tab) and Sui (Margin tab). Network doesn't matter until you're in the pool.
 */
import { Text } from "@/components/Themed";
import { useRouter } from "expo-router";
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
import { MARGIN_POOL_KEYS_SET } from "@/constants/deepbook-margin-mainnet";
import { useTicker } from "@/hooks/useDeepBookMargin";

const PRICE_POLL_MS = 5000;

function formatPairLabel(poolName: string): string {
  return poolName.replace("_", "/");
}

export type PoolListProps = {
  /** When "pools", back from pool detail goes to Pools tab; otherwise to Margin list */
  backTo?: "pools";
  title: string;
  subtitle?: string;
};

export function PoolList({ backTo, title, subtitle }: PoolListProps) {
  const colors = Colors[useColorScheme() ?? "light"];
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { ticker, loading, error } = useTicker(PRICE_POLL_MS);
  const prevPricesRef = useRef<Record<string, number>>({});
  const lastDirectionRef = useRef<Record<string, "up" | "down">>({});

  const pairs = useMemo(() => {
    const entries = Object.entries(ticker).filter(([, v]) => v?.isFrozen === 0);
    return entries
      .map(([name, data]) => ({ poolName: name, lastPrice: data.last_price }))
      .filter(
        (p) =>
          MARGIN_POOL_KEYS_SET.has(p.poolName) &&
          typeof p.lastPrice === "number" &&
          p.lastPrice > 0
      )
      .sort((a, b) => a.poolName.localeCompare(b.poolName));
  }, [ticker]);

  const onPressPool = (poolName: string) => {
    const path = `/(app)/trading/${encodeURIComponent(poolName)}`;
    router.push((backTo === "pools" ? `${path}?from=pools` : path) as never);
  };

  if (loading && pairs.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={styles.muted}>Loading…</Text>
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
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {subtitle != null && (
        <Text style={[styles.subtitle, { color: colors.text }]}>
          {subtitle}
        </Text>
      )}
    </View>
  );

  return (
    <FlatList
      data={pairs}
      keyExtractor={(item) => item.poolName}
      contentContainerStyle={styles.list}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={listHeader}
      ListEmptyComponent={
        <View style={styles.centered}>
          <Text style={styles.muted}>No pools available.</Text>
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
            onPress={() => onPressPool(item.poolName)}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
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
  header: { paddingHorizontal: 8, marginBottom: 24 },
  title: { fontSize: 28, fontWeight: "bold" },
  subtitle: { fontSize: 15, opacity: 0.8, marginTop: 8 },
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
  pairLabelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pairLabel: { fontSize: 17, fontWeight: "600" },
  priceWithArrow: { flexDirection: "row", alignItems: "center", gap: 6 },
  priceArrow: { fontSize: 12, fontWeight: "700" },
  price: { fontSize: 16, fontWeight: "500" },
  priceUp: { color: "#22c55e" },
  priceDown: { color: "#ef4444" },
  muted: { fontSize: 16, opacity: 0.7 },
  error: { fontSize: 16, color: "#ef4444" },
});
