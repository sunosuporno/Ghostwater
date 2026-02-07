import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type NetworkId = "sui-mainnet" | "base-sepolia" | "base-mainnet";

export type NetworkCapabilities = {
  /** Whether the Margin tab and trading screens should be visible. */
  showMarginTab: boolean;
  /** Whether the Pools tab (Sui margin pools — deposit from Base) should be visible. Base mainnet only. */
  showPoolsTab: boolean;
  /** Whether Sui-specific wallet UI (balances, send) should be rendered. */
  showSuiWallet: boolean;
  /** Whether EVM-style wallet UI (e.g. Base) should be rendered. */
  showEvmWallet: boolean;
  /** Whether features exclusive to Base mainnet (L2) should be shown. */
  showBaseMainnetExclusiveFeature: boolean;
};

export type NetworkConfig = {
  id: NetworkId;
  label: string;
  shortLabel: string;
  description: string;
  kind: "sui" | "evm";
  accentColor: string;
  /** EVM chainId (hex) when kind === "evm". Used for wallet_switchEthereumChain and tx params. */
  evmChainId?: string;
  capabilities: NetworkCapabilities;
};

export const NETWORKS: NetworkConfig[] = [
  {
    id: "sui-mainnet",
    label: "Sui Mainnet",
    shortLabel: "Sui",
    description: "All margin trading and transfers run on Sui.",
    kind: "sui",
    accentColor: "#32D583",
    capabilities: {
      showMarginTab: true,
      showPoolsTab: false,
      showSuiWallet: true,
      showEvmWallet: false,
      showBaseMainnetExclusiveFeature: false,
    },
  },
  {
    id: "base-sepolia",
    label: "Base Sepolia",
    shortLabel: "Base Sepolia",
    description: "Experimental L2 test network. No margin trading here yet.",
    kind: "evm",
    accentColor: "#4C6FFF",
    evmChainId: "0x14a34", // 84532
    capabilities: {
      showMarginTab: false,
      showPoolsTab: false,
      showSuiWallet: false,
      showEvmWallet: true,
      showBaseMainnetExclusiveFeature: false,
    },
  },
  {
    id: "base-mainnet",
    label: "Base",
    shortLabel: "Base",
    description: "Base L2 mainnet. No margin trading here yet.",
    kind: "evm",
    accentColor: "#0052FF",
    evmChainId: "0x2105", // 8453
    capabilities: {
      showMarginTab: false,
      showPoolsTab: true,
      showSuiWallet: false,
      showEvmWallet: true,
      showBaseMainnetExclusiveFeature: true,
    },
  },
];

/** True when the current or given network is Base mainnet (L2). Use for features exclusive to Base mainnet. */
export function isBaseMainnet(networkId: NetworkId): networkId is "base-mainnet" {
  return networkId === "base-mainnet";
}

type NetworkContextValue = {
  currentNetworkId: NetworkId;
  currentNetwork: NetworkConfig;
  setCurrentNetworkId: (id: NetworkId) => void;
};

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [currentNetworkId, setCurrentNetworkId] =
    useState<NetworkId>("sui-mainnet");

  const setNetwork = useCallback((id: NetworkId) => {
    setCurrentNetworkId(id);
  }, []);

  const currentNetwork =
    useMemo(
      () => NETWORKS.find((n) => n.id === currentNetworkId) ?? NETWORKS[0],
      [currentNetworkId]
    );

  const value = useMemo(
    () => ({
      currentNetworkId,
      currentNetwork,
      setCurrentNetworkId: setNetwork,
    }),
    [currentNetworkId, currentNetwork, setNetwork]
  );

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) {
    throw new Error("useNetwork must be used within a NetworkProvider");
  }
  return ctx;
}

