/**
 * Place margin limit or market order via backend: prepare -> sign -> execute-transfer.
 * @see https://docs.sui.io/standards/deepbook-margin-sdk/orders
 */

const DEFAULT_NETWORK = "mainnet";

export type PlaceOrderViaBackendParams = {
  apiUrl: string;
  sender: string;
  marginManagerId: string;
  poolKey: string;
  orderType: "limit" | "market";
  isBid: boolean;
  quantity: number;
  price?: number; // required for limit
  payWithDeep?: boolean;
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    hash: `0x${string}`;
  }) => Promise<{ signature: string }>;
  publicKeyHex: string;
  network?: "mainnet" | "testnet";
};

export type PlaceOrderResult = { digest: string };

async function executeSignedTx(
  base: string,
  txBytesBase64: string,
  signatureHex: string,
  publicKeyHex: string,
  network: string
): Promise<{ digest: string }> {
  const executeRes = await fetch(`${base}/api/execute-transfer`, {
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
  return { digest: executeJson.digest };
}

/** Generate a numeric client order id (u64). */
function nextClientOrderId(): number {
  return Math.floor(Date.now() % 2147483647);
}

export async function placeOrderViaBackend(
  params: PlaceOrderViaBackendParams
): Promise<PlaceOrderResult> {
  const {
    apiUrl,
    sender,
    marginManagerId,
    poolKey,
    orderType,
    isBid,
    quantity,
    price,
    payWithDeep = true,
    signRawHash,
    publicKeyHex,
    network = DEFAULT_NETWORK,
  } = params;

  if (orderType === "limit" && (price == null || Number.isNaN(price))) {
    throw new Error("Price is required for limit orders");
  }
  if (!quantity || quantity <= 0) {
    throw new Error("Quantity must be positive");
  }

  const base = apiUrl.replace(/\/$/, "");
  const clientOrderId = nextClientOrderId();

  const prepareRes = await fetch(`${base}/api/prepare-place-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender,
      marginManagerId,
      poolKey,
      orderType,
      isBid,
      quantity,
      price: orderType === "limit" ? price : undefined,
      clientOrderId,
      payWithDeep,
      network,
    }),
  });
  const prepareJson = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error(
      (prepareJson.error as string) ?? "Prepare place order failed"
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
