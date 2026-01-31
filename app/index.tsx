import { usePrivy } from '@privy-io/expo';
import { Redirect } from 'expo-router';

export default function Index() {
  const { isReady, user } = usePrivy();

  if (!isReady) {
    return null;
  }

  if (user) {
    return <Redirect href="/(app)" />;
  }

  return <Redirect href="/(auth)" />;
}
