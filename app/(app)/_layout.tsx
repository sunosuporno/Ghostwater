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
  const filteredRoutes = state.routes.filter((r) => !isPoolsRoute(r.name));
  const currentRoute = state.routes[state.index];
  const newIndex =
    currentRoute && isPoolsRoute(currentRoute.name)
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
          tabBarIcon: ({ color }) => <TabBarIcon name="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="pools"
        options={{
          title: "Pools",
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="list-alt" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="trading"
        options={{
          title: "Margin",
          href: currentNetwork.capabilities.showMarginTab ? undefined : null,
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

