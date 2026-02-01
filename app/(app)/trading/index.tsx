import { useRouter } from 'expo-router';
import { useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '@/components/Themed';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useTicker } from '@/hooks/useDeepBookMargin';

const PRICE_POLL_MS = 5000;

/** "SUI_USDC" → "SUI/USDC" */
function formatPairLabel(poolName: string): string {
  return poolName.replace('_', '/');
}

export default function TradingListScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const router = useRouter();
  const { ticker, loading, error } = useTicker(PRICE_POLL_MS);
  const prevPricesRef = useRef<Record<string, number>>({});
  const lastDirectionRef = useRef<Record<string, 'up' | 'down'>>({});

  const pairs = useMemo(() => {
    const entries = Object.entries(ticker).filter(([, v]) => v?.isFrozen === 0);
    return entries
      .map(([name, data]) => ({ poolName: name, lastPrice: data.last_price }))
      .filter((p) => typeof p.lastPrice === 'number' && p.lastPrice > 0)
      .sort((a, b) => a.poolName.localeCompare(b.poolName));
  }, [ticker]);

  const onPressPair = (poolName: string) => {
    router.push(`/(app)/trading/${encodeURIComponent(poolName)}` as const);
  };

  if (loading && pairs.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={styles.muted}>Loading pairs…</Text>
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

  return (
    <FlatList
      data={pairs}
      keyExtractor={(item) => item.poolName}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <View style={styles.centered}>
          <Text style={styles.muted}>No pairs available.</Text>
        </View>
      }
      renderItem={({ item }) => {
        const currentPrice = item.lastPrice;
        const prevPrice = prevPricesRef.current[item.poolName];
        let direction: 'up' | 'down' | null = null;
        if (typeof currentPrice === 'number') {
          if (prevPrice === undefined) {
            direction = null;
          } else if (currentPrice > prevPrice) {
            direction = 'up';
            lastDirectionRef.current[item.poolName] = 'up';
          } else if (currentPrice < prevPrice) {
            direction = 'down';
            lastDirectionRef.current[item.poolName] = 'down';
          } else {
            direction = lastDirectionRef.current[item.poolName] ?? null;
          }
          prevPricesRef.current[item.poolName] = currentPrice;
        }
        const priceText =
          typeof currentPrice === 'number'
            ? currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
            : '—';
        return (
          <Pressable
            onPress={() => onPressPair(item.poolName)}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: colors.background, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={styles.pairLabel}>{formatPairLabel(item.poolName)}</Text>
            <View style={styles.priceWithArrow}>
              {direction === 'up' && (
                <Text style={[styles.priceArrow, styles.priceUp]} allowFontScaling={false}>▲</Text>
              )}
              {direction === 'down' && (
                <Text style={[styles.priceArrow, styles.priceDown]} allowFontScaling={false}>▼</Text>
              )}
              <Text
                style={[
                  styles.price,
                  { color: colors.text },
                  direction === 'up' && styles.priceUp,
                  direction === 'down' && styles.priceDown,
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
  list: { padding: 16, paddingBottom: 32 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(128,128,128,0.2)',
  },
  pairLabel: { fontSize: 17, fontWeight: '600' },
  priceWithArrow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  priceArrow: { fontSize: 12, fontWeight: '700' },
  price: { fontSize: 16, fontWeight: '500' },
  priceUp: { color: '#22c55e' },
  priceDown: { color: '#ef4444' },
  muted: { fontSize: 16, opacity: 0.7 },
  error: { fontSize: 16, color: '#ef4444' },
});
