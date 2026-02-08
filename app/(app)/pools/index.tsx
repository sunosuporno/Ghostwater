import { Redirect } from "expo-router";
import { useNetwork } from "@/lib/network";
import { PoolList } from "@/components/PoolList";

/** Base: Deepbook tab. Same list as Margin on Sui — tap tab → list, tap item → pool. */
export default function PoolsScreen() {
  const { currentNetwork } = useNetwork();

  if (!currentNetwork.capabilities.showPoolsTab) {
    return <Redirect href="/(app)" />;
  }

  return (
    <PoolList
      backTo="pools"
      title="Sui margin pools"
      subtitle="Deposit from Base into a pool to trade with margin on Sui."
    />
  );
}
