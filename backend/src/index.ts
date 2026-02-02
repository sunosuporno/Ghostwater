import cors from "cors";
import "dotenv/config";
import express from "express";
import { executeTransfer } from "./sui/execute-transfer.js";
import { prepareTransfer } from "./sui/prepare-transfer.js";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

/**
 * POST /api/prepare-transfer
 * Body: { sender, recipient, coinType, amountMist, network? }
 * Returns: { intentMessageHex, txBytesBase64 } for the client to sign.
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

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
