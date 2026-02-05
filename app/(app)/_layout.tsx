import { AuthBoundary } from "@privy-io/expo";
import { Redirect, Tabs } from "expo-router";
import FontAwesome from "@expo/vector-icons/FontAwesome";

import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { TickerProvider } from "@/hooks/useDeepBookMargin";
import { NetworkProvider, useNetwork } from "@/lib/network";

function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>["name"];
  color: string;
}) {
  return <FontAwesome size={28} style={{ marginBottom: -3 }} {...props} />;
}

function AppTabs() {
  const colorScheme = useColorScheme();
  const { currentNetwork } = useNetwork();

  return (
    <Tabs
      key={currentNetwork.id}
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? "light"].tint,
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <TabBarIcon name="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="trading"
        options={{
          title: "Margin",
          // When margin is not supported on this network, completely hide the tab.
          href: currentNetwork.capabilities.showMarginTab ? undefined : null,
          tabBarStyle: currentNetwork.capabilities.showMarginTab
            ? undefined
            : { display: "none" },
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="line-chart" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

export default function AppLayout() {
  return (
    <AuthBoundary
      loading={null}
      error={() => null}
      unauthenticated={<Redirect href="/(auth)" />}
    >
      <NetworkProvider>
        <TickerProvider>
          <AppTabs />
        </TickerProvider>
      </NetworkProvider>
    </AuthBoundary>
  );
}

