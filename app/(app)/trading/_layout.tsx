import { Stack } from 'expo-router';

export default function TradingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackTitle: 'Pairs',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Margin', headerTitle: 'Pairs' }} />
      <Stack.Screen name="[poolName]" options={{ title: 'Pair', headerTitle: '' }} />
    </Stack>
  );
}
