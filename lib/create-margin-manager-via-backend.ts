/**
 * Create a margin manager via backend: prepare -> sign -> execute.
 * Returns the new margin_manager_id so the app can refetch owned managers.
 */

const DEFAULT_NETWORK = "mainnet";

export type CreateMarginManagerViaBackendParams = {
  apiUrl: string;
  sender: string;
  poolKey: string;
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    hash: `0x${string}`;
  }) => Promise<{ signature: string }>;
  publicKeyHex: string;
  network?: "mainnet" | "testnet";
};

export type CreateMarginManagerViaBackendResult = {
  digest: string;
  margin_manager_id: string;
};

export async function createMarginManagerViaBackend(
  params: CreateMarginManagerViaBackendParams
): Promise<CreateMarginManagerViaBackendResult> {
  const {
    apiUrl,
    sender,
    poolKey,
    signRawHash,
    publicKeyHex,
    network = DEFAULT_NETWORK,
  } = params;

  const base = apiUrl.replace(/\/$/, "");

  const prepareRes = await fetch(`${base}/api/prepare-create-margin-manager`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, poolKey, network }),
  });
  const prepareJson = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error((prepareJson.error as string) ?? "Prepare failed");
  }

  const intentMessageHashHex =
    prepareJson.intentMessageHashHex ?? prepareJson.intent_message_hash_hex;
  const txBytesBase64 =
    prepareJson.txBytesBase64 ?? prepareJson.tx_bytes_base64;

  if (
    typeof intentMessageHashHex !== "string" ||
    !intentMessageHashHex ||
    typeof txBytesBase64 !== "string" ||
    !txBytesBase64
  ) {
    throw new Error(
      "Invalid prepare response: missing intentMessageHashHex or txBytesBase64"
    );
  }

  const { signature: signatureHex } = await signRawHash({
    address: sender,
    chainType: "sui",
    hash: intentMessageHashHex.startsWith("0x")
      ? (intentMessageHashHex as `0x${string}`)
      : (`0x${intentMessageHashHex}` as `0x${string}`),
  });

  const executeRes = await fetch(`${base}/api/execute-create-margin-manager`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      txBytesBase64,
      signatureHex,
      publicKeyHex: publicKeyHex.startsWith("0x")
        ? publicKeyHex
        : "0x" + publicKeyHex,
      network,
    }),
  });
  const executeJson = await executeRes.json();
  if (!executeRes.ok) {
    throw new Error((executeJson.error as string) ?? "Execute failed");
  }

  const margin_manager_id =
    executeJson.margin_manager_id ?? executeJson.marginManagerId;
  if (typeof margin_manager_id !== "string" || !margin_manager_id) {
    throw new Error("Execute response missing margin_manager_id");
  }

  return {
    digest: executeJson.digest,
    margin_manager_id,
  };
}
