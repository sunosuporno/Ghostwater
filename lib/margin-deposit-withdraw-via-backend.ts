/**
 * Margin deposit/withdraw via backend: prepare -> sign -> execute-transfer.
 */

const DEFAULT_NETWORK = "mainnet";

export type MarginDepositViaBackendParams = {
  apiUrl: string;
  sender: string;
  marginManagerId: string;
  poolKey: string;
  asset: "base" | "quote" | "deep";
  amount: number;
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    hash: `0x${string}`;
  }) => Promise<{ signature: string }>;
  publicKeyHex: string;
  network?: "mainnet" | "testnet";
};

export type MarginWithdrawViaBackendParams = MarginDepositViaBackendParams;

export type MarginActionResult = { digest: string };

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

export async function depositMarginViaBackend(
  params: MarginDepositViaBackendParams
): Promise<MarginActionResult> {
  const {
    apiUrl,
    sender,
    marginManagerId,
    poolKey,
    asset,
    amount,
    signRawHash,
    publicKeyHex,
    network = DEFAULT_NETWORK,
  } = params;

  const base = apiUrl.replace(/\/$/, "");

  const prepareRes = await fetch(`${base}/api/prepare-margin-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender,
      marginManagerId,
      poolKey,
      asset,
      amount,
      network,
    }),
  });
  const prepareJson = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error((prepareJson.error as string) ?? "Prepare deposit failed");
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

export async function withdrawMarginViaBackend(
  params: MarginWithdrawViaBackendParams
): Promise<MarginActionResult> {
  const {
    apiUrl,
    sender,
    marginManagerId,
    poolKey,
    asset,
    amount,
    signRawHash,
    publicKeyHex,
    network = DEFAULT_NETWORK,
  } = params;

  const base = apiUrl.replace(/\/$/, "");

  const prepareRes = await fetch(`${base}/api/prepare-margin-withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender,
      marginManagerId,
      poolKey,
      asset,
      amount,
      network,
    }),
  });
  const prepareJson = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error((prepareJson.error as string) ?? "Prepare withdraw failed");
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

export type RepayViaBackendParams = {
  apiUrl: string;
  sender: string;
  marginManagerId: string;
  poolKey: string;
  baseAmount?: number;
  quoteAmount?: number;
  signRawHash: (params: {
    address: string;
    chainType: "sui";
    hash: `0x${string}`;
  }) => Promise<{ signature: string }>;
  publicKeyHex: string;
  network?: "mainnet" | "testnet";
};

export async function repayViaBackend(
  params: RepayViaBackendParams
): Promise<MarginActionResult> {
  const {
    apiUrl,
    sender,
    marginManagerId,
    poolKey,
    baseAmount = 0,
    quoteAmount = 0,
    signRawHash,
    publicKeyHex,
    network = DEFAULT_NETWORK,
  } = params;

  if (baseAmount <= 0 && quoteAmount <= 0) {
    throw new Error("At least one of baseAmount or quoteAmount must be positive");
  }

  const base = apiUrl.replace(/\/$/, "");

  const prepareRes = await fetch(`${base}/api/prepare-repay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender,
      marginManagerId,
      poolKey,
      baseAmount: baseAmount > 0 ? baseAmount : undefined,
      quoteAmount: quoteAmount > 0 ? quoteAmount : undefined,
      network,
    }),
  });
  const prepareJson = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error((prepareJson.error as string) ?? "Prepare repay failed");
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
