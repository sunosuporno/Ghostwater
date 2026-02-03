/**
 * Add Take Profit and/or Stop Loss conditional orders via backend.
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/tpsl
 */

const DEFAULT_NETWORK = "mainnet";

export type AddTpslViaBackendParams = {
  apiUrl: string;
  sender: string;
  marginManagerId: string;
  poolKey: string;
  isLong: boolean;
  quantity: number;
  tpPrice?: number;
  slPrice?: number;
  payWithDeep?: boolean;
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    hash: `0x${string}`;
  }) => Promise<{ signature: string }>;
  publicKeyHex: string;
  network?: "mainnet" | "testnet";
};

export type AddTpslResult = { digest: string };

async function executeSignedTx(
  base: string,
  txBytesBase64: string,
  signatureHex: string,
  publicKeyHex: string,
  network: string
): Promise<{ digest: string }> {
  const res = await fetch(`${base}/api/execute-transfer`, {
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
  const json = await res.json();
  if (!res.ok) throw new Error((json.error as string) ?? "Execute failed");
  return { digest: json.digest };
}

export async function addTpslViaBackend(
  params: AddTpslViaBackendParams
): Promise<AddTpslResult> {
  const {
    apiUrl,
    sender,
    marginManagerId,
    poolKey,
    isLong,
    quantity,
    tpPrice,
    slPrice,
    payWithDeep = true,
    signRawHash,
    publicKeyHex,
    network = DEFAULT_NETWORK,
  } = params;

  if (tpPrice == null && slPrice == null) {
    throw new Error("At least one of tpPrice or slPrice is required");
  }
  if (!quantity || quantity <= 0) {
    throw new Error("Quantity must be positive");
  }

  const base = apiUrl.replace(/\/$/, "");
  const prepareRes = await fetch(`${base}/api/prepare-add-tpsl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender,
      marginManagerId,
      poolKey,
      isLong,
      quantity,
      tpPrice: tpPrice != null ? tpPrice : undefined,
      slPrice: slPrice != null ? slPrice : undefined,
      payWithDeep,
      network,
    }),
  });
  const prepareJson = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error(
      (prepareJson.error as string) ?? "Prepare add TP/SL failed"
    );
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
    throw new Error("Invalid prepare response");
  }

  const { signature: signatureHex } = await signRawHash({
    address: sender,
    chainType: "sui",
    hash: intentMessageHashHex.startsWith("0x")
      ? (intentMessageHashHex as `0x${string}`)
      : (`0x${intentMessageHashHex}` as `0x${string}`),
  });

  return executeSignedTx(
    base,
    txBytesBase64,
    signatureHex,
    publicKeyHex,
    network
  );
}
