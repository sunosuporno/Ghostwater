import { AuthBoundary } from "@privy-io/expo";
import { BottomTabBar } from "@react-navigation/bottom-tabs";
import { Redirect, Tabs } from "expo-router";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

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

/** Tab bar that omits Pools when showPoolsTab is false (e.g. on Sui). Expo still registers pools from the file system, so we filter it out here. */
function FilteredTabBar(props: BottomTabBarProps) {
  const { currentNetwork } = useNetwork();

  if (currentNetwork.capabilities.showPoolsTab) {
    return <BottomTabBar {...props} />;
  }

  const { state, descriptors } = props;
  const isPoolsRoute = (name: string) =>
    name === "pools" || name.startsWith("pools/");
  const isLstRoute = (name: string) => name === "lst" || name.startsWith("lst/");
  const isSwapRoute = (name: string) => name === "swap" || name.startsWith("swap/");
  const filteredRoutes = state.routes.filter(
    (r) =>
      !isPoolsRoute(r.name) &&
      !(isLstRoute(r.name) && !currentNetwork.capabilities.showLstTab) &&
      !(isSwapRoute(r.name) && !currentNetwork.capabilities.showSwapTab)
  );
  const currentRoute = state.routes[state.index];
  const currentFilteredOut =
    currentRoute &&
    (isPoolsRoute(currentRoute.name) ||
      (isLstRoute(currentRoute.name) && !currentNetwork.capabilities.showLstTab) ||
      (isSwapRoute(currentRoute.name) && !currentNetwork.capabilities.showSwapTab));
  const newIndex = currentFilteredOut
    ? 0
    : Math.max(
        0,
        filteredRoutes.findIndex((r) => r.name === currentRoute?.name)
      );
  const filteredState = {
    ...state,
    routes: filteredRoutes,
    index: newIndex,
  };
  const filteredDescriptors: typeof descriptors = {};
  filteredRoutes.forEach((r) => {
    if (descriptors[r.key]) filteredDescriptors[r.key] = descriptors[r.key];
  });

  return (
    <BottomTabBar
      {...props}
      state={filteredState}
      descriptors={filteredDescriptors}
    />
  );
}

function AppTabs() {
  const colorScheme = useColorScheme();
  const { currentNetwork } = useNetwork();

  return (
    <Tabs
      key={currentNetwork.id}
      tabBar={(props) => <FilteredTabBar {...props} />}
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? "light"].tint,
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarLabel: "Home",
          tabBarIcon: ({ color }) => <TabBarIcon name="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="pools/index"
        options={{
          title: "Deepbook",
          tabBarLabel: "Deepbook",
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="book" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="trading"
        options={{
          title: "Margin",
          tabBarLabel: "Margin",
          href: currentNetwork.capabilities.showMarginTab ? undefined : null,
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="line-chart" color={color} />
          ),
          // Tap tab → show list.
          ...({
            listeners: ({
              navigation,
            }: {
              navigation: { navigate: (name: string) => void };
            }) => ({
              tabPress: () => navigation.navigate("index"),
            }),
          } as Record<string, unknown>),
        }}
      />
      <Tabs.Screen
        name="lst/index"
        options={{
          title: "LST",
          tabBarLabel: "LST",
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="tint" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="swap/index"
        options={{
          title: "Swap",
          tabBarLabel: "Swap",
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="exchange" color={color} />
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

