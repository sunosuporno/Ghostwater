import { Text } from "@/components/Themed";
import { useColorScheme } from "@/components/useColorScheme";
import { TRADINGVIEW_CHARTING_LIBRARY_PATH } from "@/constants/TradingView";
import { getTradingViewAdvancedChartHtml } from "@/lib/tradingview-advanced-chart-html";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import WebView from "react-native-webview";

export default function TradingViewFullChartScreen() {
  const { poolName } = useLocalSearchParams<{ poolName: string }>();
  const decodedPoolName = poolName ? decodeURIComponent(poolName) : null;
  const navigation = useNavigation();
  const colorScheme = useColorScheme();
  const [chartError, setChartError] = useState<string | null>(null);

  const displayLabel = decodedPoolName
    ? decodedPoolName.replace("_", "/")
    : "—";

  useEffect(() => {
    navigation.setOptions({ title: `${displayLabel} · TradingView` });
  }, [navigation, displayLabel]);

  const onMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "chartReady") setChartError(null);
      if (msg.type === "error") setChartError(msg.message ?? "Chart error");
    } catch {
      // ignore
    }
  }, []);

  if (!decodedPoolName) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Invalid pair.</Text>
      </View>
    );
  }

  const theme = colorScheme === "dark" ? "dark" : "light";
  const { width, height } = Dimensions.get("window");
  const html = getTradingViewAdvancedChartHtml(
    decodedPoolName,
    TRADINGVIEW_CHARTING_LIBRARY_PATH,
    theme,
    width,
    height - 120
  );

  return (
    <View style={styles.container}>
      {chartError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{chartError}</Text>
        </View>
      ) : null}
      <WebView
        source={{ html }}
        style={styles.webview}
        scrollEnabled={true}
        showsVerticalScrollIndicator={false}
        onMessage={onMessage}
        originWhitelist={["*"]}
        mixedContentMode="compatibility"
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  muted: { fontSize: 14, opacity: 0.7 },
  errorBox: {
    padding: 12,
    backgroundColor: "rgba(239,68,68,0.15)",
  },
  errorText: { color: "#ef4444", fontSize: 14 },
  webview: { flex: 1, backgroundColor: "transparent" },
});
