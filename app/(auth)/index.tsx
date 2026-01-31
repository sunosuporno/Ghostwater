import { useLoginWithOAuth, hasError } from '@privy-io/expo';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Themed';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

export default function LoginScreen() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const { login, state } = useLoginWithOAuth();
  const colors = Colors[colorScheme ?? 'light'];

  const handleLogin = async () => {
    try {
      await login({ provider: 'google' });
      router.replace('/(app)');
    } catch (err) {
      console.error('Login failed', err);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to Ghostwater</Text>
      <Text style={styles.subtitle}>
        Sign in with Google to get started. We'll create a wallet for you.
      </Text>
      <Pressable
        onPress={handleLogin}
        disabled={state.status === 'loading'}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
        ]}
      >
        <Text style={[styles.buttonText, { color: colors.background }]}>
          {state.status === 'loading' ? 'Logging in...' : 'Log in with Google'}
        </Text>
      </Pressable>
      {hasError(state) && state.error && (
        <Text style={styles.error}>Error: {state.error.message}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    opacity: 0.8,
    marginBottom: 32,
    textAlign: 'center',
  },
  button: {
    minWidth: 200,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    marginTop: 16,
    color: '#c00',
    textAlign: 'center',
  },
});
