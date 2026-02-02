import { Buffer } from "buffer";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { executeCreateMarginManager } from "./sui/execute-create-margin-manager.js";
import { executeTransfer } from "./sui/execute-transfer.js";
import { getOwnedMarginManagers } from "./sui/owned-margin-managers.js";
import { prepareCreateMarginManager } from "./sui/prepare-create-margin-manager.js";
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
    const result = await getOwnedMarginManagers({ owner, network });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch";
    res.status(400).json({ error: message });
  }
});

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
