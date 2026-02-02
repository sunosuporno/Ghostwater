# Ghostwater Backend

Node API used by the app for Sui transfers on React Native (avoids loading `@mysten/sui` in the app).

## Setup

1. **Install dependencies**

   ```bash
   cd backend
   npm install
   ```

2. **Environment (optional)**

   Copy `.env.example` to `.env` and set `PORT` if you want a different port (default 3001).

3. **Run**

   ```bash
   npm run dev
   ```

   Server runs at `http://localhost:3001`.

## Endpoints

- **POST /api/prepare-transfer**  
  Body: `{ sender, recipient, coinType, amountMist, network? }`  
  Returns: `{ intentMessageHex, txBytesBase64 }` for the client to sign.

- **POST /api/execute-transfer**  
  Body: `{ txBytesBase64, signatureHex, publicKeyHex, network? }`  
  Submits the signed transaction and returns `{ digest }`.

## App usage

Set `EXPO_PUBLIC_API_URL` in the app’s `.env` (e.g. `http://localhost:3001` for simulator, or `http://YOUR_MACHINE_IP:3001` for a physical device on the same network).
