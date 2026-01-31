import {
  useEmbeddedEthereumWallet,
  usePrivy,
} from '@privy-io/expo';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '@/components/Themed';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

function truncateAddress(address: string) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const { user, logout } = usePrivy();
  const { wallets, create } = useEmbeddedEthereumWallet();
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCreateError(null);

    const run = async () => {
      if (wallets.length > 0) {
        try {
          const provider = await wallets[0].getProvider();
          const accounts = (await provider.request({
            method: 'eth_requestAccounts',
          })) as string[];
          if (!cancelled && accounts[0]) setAddress(accounts[0]);
        } catch {
          if (!cancelled) setCreateError('Could not get wallet address');
        }
        if (!cancelled) setLoading(false);
        return;
      }

      try {
        await create({});
      } catch (err) {
        if (!cancelled) {
          setCreateError(err instanceof Error ? err.message : 'Failed to create wallet');
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

  const handleLogout = useCallback(() => {
    logout();
  }, [logout]);

  if (loading && !address) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={styles.loadingText}>Setting up your wallet...</Text>
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
        {user?.email?.address ?? user?.google?.email ?? 'Signed in'}
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Your wallet address</Text>
        {createError ? (
          <Text style={styles.error}>{createError}</Text>
        ) : address ? (
          <>
            <Text style={styles.address} selectable>
              {address}
            </Text>
            <Text style={styles.addressShort}>{truncateAddress(address)}</Text>
          </>
        ) : (
          <Text style={styles.muted}>No wallet yet</Text>
        )}
      </View>

      <Pressable
        onPress={handleLogout}
        style={({ pressed }) => [
          styles.logoutButton,
          { backgroundColor: colors.tabIconDefault, opacity: pressed ? 0.8 : 1 },
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
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
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
    borderColor: 'rgba(128,128,128,0.3)',
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: '600',
    opacity: 0.8,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  address: {
    fontSize: 14,
    fontFamily: 'SpaceMono',
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
    color: '#c00',
  },
  logoutButton: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    alignSelf: 'center',
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
