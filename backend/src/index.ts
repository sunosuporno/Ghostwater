import { Buffer } from "buffer";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { executeCreateMarginManager } from "./sui/execute-create-margin-manager.js";
import { executeTransfer } from "./sui/execute-transfer.js";
import { fetchMarginBorrowedShares } from "./sui/fetch-margin-borrowed-shares.js";
import { getOwnedMarginManagers } from "./sui/owned-margin-managers.js";
import { prepareAddTpsl } from "./sui/prepare-add-tpsl.js";
import { prepareCreateMarginManager } from "./sui/prepare-create-margin-manager.js";
import { prepareMarginDeposit } from "./sui/prepare-margin-deposit.js";
import { prepareMarginWithdraw } from "./sui/prepare-margin-withdraw.js";
import { preparePlaceOrder } from "./sui/prepare-place-order.js";
import { prepareRepay } from "./sui/prepare-repay.js";
import { prepareExternalSuiTx } from "./sui/prepare-external-sui-tx.js";
import { prepareTransfer } from "./sui/prepare-transfer.js";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

/**
 * POST /api/prepare-transfer
 * Body: { sender, recipient, coinType, amountMist, network? }
 * Returns: { intentMessageHashHex, txBytesBase64 } for the client to sign (hash = blake2b256 of intent message).
 */
app.post("/api/prepare-transfer", async (req, res) => {
  try {
    const { sender, recipient, coinType, amountMist, network } = req.body;
    if (!sender || !recipient || !coinType || amountMist == null) {
      res.status(400).json({
        error:
          "Missing required fields: sender, recipient, coinType, amountMist",
      });
      return;
    }
    const result = await prepareTransfer({
      sender,
      recipient,
      coinType,
      amountMist: String(amountMist),
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Prepare failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/prepare-external-sui-tx
 * Body: { txBytesBase64 } — arbitrary Sui tx bytes (e.g. from LiFi quote).
 * Returns: { intentMessageHashHex } for the client to sign. Then POST /api/execute-transfer.
 */
app.post("/api/prepare-external-sui-tx", async (req, res) => {
  try {
    const { txBytesBase64 } = req.body;
    if (!txBytesBase64) {
      res.status(400).json({ error: "Missing required field: txBytesBase64" });
      return;
    }
    const result = await prepareExternalSuiTx({ txBytesBase64 });
    res.json(result);
  } catch (err) {
    console.error("[prepare-external-sui-tx] error:", err);
    const message =
      err instanceof Error ? err.message : "Prepare external Sui tx failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/execute-transfer
 * Body: { txBytesBase64, signatureHex, publicKeyHex, network? }
 * Submits the signed transaction to Sui and returns { digest }.
 */
app.post("/api/execute-transfer", async (req, res) => {
  try {
    const { txBytesBase64, signatureHex, publicKeyHex, network } = req.body;
    if (!txBytesBase64 || !signatureHex || !publicKeyHex) {
      res.status(400).json({
        error:
          "Missing required fields: txBytesBase64, signatureHex, publicKeyHex",
      });
      return;
    }
    const result = await executeTransfer({
      txBytesBase64,
      signatureHex,
      publicKeyHex,
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execute failed";
    res.status(400).json({ error: message });
  }
});

/**
 * GET /api/owned-margin-managers?owner=0x...&network=mainnet
 * Returns { managers: { margin_manager_id, deepbook_pool_id }[] } from chain.
 */
app.get("/api/owned-margin-managers", async (req, res) => {
  try {
    const owner = req.query.owner as string;
    const network = (req.query.network as "mainnet" | "testnet") ?? "mainnet";
    if (!owner) {
      res.status(400).json({ error: "Missing query: owner" });
      return;
    }
    console.log("[api/owned-margin-managers] request", {
      owner,
      network,
    });
    const result = await getOwnedMarginManagers({ owner, network });
    console.log("[api/owned-margin-managers] response", {
      count: result.managers.length,
      managers: result.managers,
    });
    res.json(result);
  } catch (err) {
    console.error("[api/owned-margin-managers] error", err);
    const message = err instanceof Error ? err.message : "Failed to fetch";
    res.status(400).json({ error: message });
  }
});

/**
 * GET /api/margin-borrowed-shares
 * (Legacy name; same as /api/margin-manager-state.)
 */
app.get("/api/margin-borrowed-shares", marginManagerStateHandler);

/**
 * GET /api/margin-manager-state
 *
 * Postman: one endpoint that returns all Margin Manager SDK read-only data from chain.
 *
 * Method: GET
 * URL:    http://localhost:3001/api/margin-manager-state
 *
 * Query params:
 *   marginManagerId   (required)  Margin manager object ID (0x...).
 *   poolKey           (required)  Pool key (e.g. SUI_USDC). Used by SDK for type args.
 *   network           (optional)  "mainnet" | "testnet". Default: mainnet.
 *   debug             (optional)  "1" or "true" to include _debug.resultCount in response.
 *
 * Example:
 *   GET http://localhost:3001/api/margin-manager-state?marginManagerId=0x...&poolKey=SUI_USDC
 *
 * Response: single JSON object with borrowedShares, borrowedBaseShares, borrowedQuoteShares,
 *   hasBaseDebt, balanceManager, calculateAssets, calculateDebts, source, and optionally _debug.
 */
app.get("/api/margin-manager-state", marginManagerStateHandler);

async function marginManagerStateHandler(
  req: express.Request,
  res: express.Response
): Promise<void> {
  try {
    const marginManagerId = (req.query.marginManagerId as string)?.trim();
    const poolKey = (req.query.poolKey as string)?.trim();
    const network = ((req.query.network as string) || "mainnet") as "mainnet" | "testnet";
    const debug =
      req.query.debug === "1" ||
      req.query.debug === "true" ||
      req.query.debug === "yes";
    if (!marginManagerId) {
      res.status(400).json({
        error: "Missing required query param: marginManagerId",
        params: {
          marginManagerId: "required — margin manager object ID (0x...)",
          poolKey: "required — e.g. SUI_USDC",
          network: "optional — mainnet | testnet",
          debug: "optional — 1 | true to include _debug.resultCount",
        },
      });
      return;
    }
    if (!poolKey) {
      res.status(400).json({
        error: "Missing required query param: poolKey (e.g. SUI_USDC)",
        params: {
          marginManagerId: "required — margin manager object ID (0x...)",
          poolKey: "required — e.g. SUI_USDC",
          network: "optional — mainnet | testnet",
          debug: "optional — 1 | true",
        },
      });
      return;
    }
    const result = await fetchMarginBorrowedShares({
      marginManagerId,
      poolKey,
      network,
      debug,
    });
    res.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch margin manager state";
    res.status(400).json({ error: message });
  }
}

/**
 * POST /api/prepare-create-margin-manager
 * Body: { sender, poolKey, network? }
 * Returns: { intentMessageHashHex, txBytesBase64 }
 */
app.post("/api/prepare-create-margin-manager", async (req, res) => {
  try {
    const { sender, poolKey, network } = req.body;
    if (!sender || !poolKey) {
      res.status(400).json({
        error: "Missing required fields: sender, poolKey",
      });
      return;
    }
    const result = await prepareCreateMarginManager({
      sender,
      poolKey,
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Prepare failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/prepare-margin-deposit
 * Body: { sender, marginManagerId, poolKey, asset: 'base'|'quote'|'deep', amount, network? }
 * Returns: { intentMessageHashHex, txBytesBase64 }. Execute via POST /api/execute-transfer.
 */
app.post("/api/prepare-margin-deposit", async (req, res) => {
  try {
    const { sender, marginManagerId, poolKey, asset, amount, network } =
      req.body;
    if (
      !sender ||
      !marginManagerId ||
      !poolKey ||
      asset == null ||
      amount == null
    ) {
      res.status(400).json({
        error:
          "Missing required fields: sender, marginManagerId, poolKey, asset, amount",
      });
      return;
    }
    const result = await prepareMarginDeposit({
      sender,
      marginManagerId,
      poolKey,
      asset,
      amount: Number(amount),
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Prepare failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/prepare-margin-withdraw
 * Body: { sender, marginManagerId, poolKey, asset: 'base'|'quote'|'deep', amount, network? }
 * Returns: { intentMessageHashHex, txBytesBase64 }. Execute via POST /api/execute-transfer.
 */
app.post("/api/prepare-margin-withdraw", async (req, res) => {
  try {
    const { sender, marginManagerId, poolKey, asset, amount, network } =
      req.body;
    if (
      !sender ||
      !marginManagerId ||
      !poolKey ||
      asset == null ||
      amount == null
    ) {
      res.status(400).json({
        error:
          "Missing required fields: sender, marginManagerId, poolKey, asset, amount",
      });
      return;
    }
    const result = await prepareMarginWithdraw({
      sender,
      marginManagerId,
      poolKey,
      asset,
      amount: Number(amount),
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Prepare failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/prepare-repay
 * Body: { sender, marginManagerId, poolKey, baseAmount?, quoteAmount?, network? }
 * Returns: { intentMessageHashHex, txBytesBase64 }. Execute via POST /api/execute-transfer.
 */
app.post("/api/prepare-repay", async (req, res) => {
  try {
    const { sender, marginManagerId, poolKey, baseAmount, quoteAmount, network } =
      req.body;
    if (!sender || !marginManagerId || !poolKey) {
      res.status(400).json({
        error: "Missing required fields: sender, marginManagerId, poolKey",
      });
      return;
    }
    const base = baseAmount != null ? Number(baseAmount) : 0;
    const quote = quoteAmount != null ? Number(quoteAmount) : 0;
    if (base <= 0 && quote <= 0) {
      res.status(400).json({
        error: "At least one of baseAmount or quoteAmount must be positive",
      });
      return;
    }
    const result = await prepareRepay({
      sender,
      marginManagerId,
      poolKey,
      baseAmount: base > 0 ? base : undefined,
      quoteAmount: quote > 0 ? quote : undefined,
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Prepare repay failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/prepare-place-order
 * Body: { sender, marginManagerId, poolKey, orderType, isBid, quantity, price?, clientOrderId, payWithDeep?, network?, borrowBaseAmount?, borrowQuoteAmount? }
 * Returns: { intentMessageHashHex, txBytesBase64 }. Execute via POST /api/execute-transfer.
 */
app.post("/api/prepare-place-order", async (req, res) => {
  try {
    const {
      sender,
      marginManagerId,
      poolKey,
      orderType,
      isBid,
      quantity,
      price,
      clientOrderId,
      payWithDeep,
      network,
      reduceOnly,
      borrowBaseAmount,
      borrowQuoteAmount,
    } = req.body;
    if (
      !sender ||
      !marginManagerId ||
      !poolKey ||
      orderType == null ||
      isBid == null ||
      quantity == null ||
      clientOrderId == null
    ) {
      res.status(400).json({
        error:
          "Missing required fields: sender, marginManagerId, poolKey, orderType, isBid, quantity, clientOrderId",
      });
      return;
    }
    if (orderType !== "limit" && orderType !== "market") {
      res.status(400).json({ error: "orderType must be 'limit' or 'market'" });
      return;
    }
    // Only treat explicit boolean false as false; otherwise default true (avoids string "false" → true).
    const payWithDeepFlag =
      typeof payWithDeep === "boolean" ? payWithDeep : true;

    const result = await preparePlaceOrder({
      sender,
      marginManagerId,
      poolKey,
      orderType,
      isBid: Boolean(isBid),
      quantity: Number(quantity),
      price: price != null ? Number(price) : undefined,
      clientOrderId: Number(clientOrderId),
      payWithDeep: payWithDeepFlag,
      network: network ?? "mainnet",
      reduceOnly: Boolean(reduceOnly),
      borrowBaseAmount:
        borrowBaseAmount != null && Number(borrowBaseAmount) > 0
          ? Number(borrowBaseAmount)
          : undefined,
      borrowQuoteAmount:
        borrowQuoteAmount != null && Number(borrowQuoteAmount) > 0
          ? Number(borrowQuoteAmount)
          : undefined,
    });
    res.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Prepare place order failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/prepare-add-tpsl
 * Body: { sender, marginManagerId, poolKey, isLong, quantity, tpPrice?, slPrice?, payWithDeep?, network? }
 * Returns: { intentMessageHashHex, txBytesBase64 }. Execute via POST /api/execute-transfer.
 */
app.post("/api/prepare-add-tpsl", async (req, res) => {
  try {
    const {
      sender,
      marginManagerId,
      poolKey,
      isLong,
      quantity,
      tpPrice,
      slPrice,
      payWithDeep,
      network,
    } = req.body;
    if (
      !sender ||
      !marginManagerId ||
      !poolKey ||
      isLong == null ||
      quantity == null
    ) {
      res.status(400).json({
        error:
          "Missing required fields: sender, marginManagerId, poolKey, isLong, quantity",
      });
      return;
    }
    if (tpPrice == null && slPrice == null) {
      res.status(400).json({
        error: "At least one of tpPrice or slPrice is required",
      });
      return;
    }
    const result = await prepareAddTpsl({
      sender,
      marginManagerId,
      poolKey,
      isLong: Boolean(isLong),
      quantity: Number(quantity),
      tpPrice: tpPrice != null ? Number(tpPrice) : undefined,
      slPrice: slPrice != null ? Number(slPrice) : undefined,
      payWithDeep: payWithDeep != null ? Boolean(payWithDeep) : true,
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Prepare add TP/SL failed";
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/execute-create-margin-manager
 * Body: { txBytesBase64, signatureHex, publicKeyHex, network? }
 * Returns: { digest, margin_manager_id }
 */
app.post("/api/execute-create-margin-manager", async (req, res) => {
  try {
    const { txBytesBase64, signatureHex, publicKeyHex, network } = req.body;
    if (!txBytesBase64 || !signatureHex || !publicKeyHex) {
      res.status(400).json({
        error:
          "Missing required fields: txBytesBase64, signatureHex, publicKeyHex",
      });
      return;
    }
    const result = await executeCreateMarginManager({
      txBytesBase64,
      signatureHex,
      publicKeyHex,
      network: network ?? "mainnet",
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execute failed";
    res.status(400).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
