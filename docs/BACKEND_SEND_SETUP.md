# Backend send setup (step-by-step)

Send on the **native app** (iOS/Android) uses a small Node backend so we never load `@mysten/sui` in React Native. Follow these steps to run everything in one repo.

---

## 1. Backend lives in this repo

The backend is in the **`backend/`** folder:

```
Ghostwater/
├── app/           # Expo app
├── backend/      # Node API (prepare + execute Sui transfers)
├── lib/
├── package.json  # Expo app deps
└── ...
```

---

## 2. Install and run the backend

From the **project root**:

```bash
cd backend
npm install
npm run dev
```

You should see: `Backend running at http://localhost:3001`

Leave this terminal open. The backend will reload on file changes.

---

## 3. Configure the app to use the backend

In the **project root** (not inside `backend/`), copy env example and set the API URL:

```bash
cp .env.example .env
```

Edit **`.env`** and set:

- **iOS Simulator / Android Emulator:**  
  `EXPO_PUBLIC_API_URL=http://localhost:3001`

- **Physical device (phone on same Wi‑Fi):**  
  Use your machine’s IP, e.g.  
  `EXPO_PUBLIC_API_URL=http://192.168.1.5:3001`  
  (Find IP: Mac → System Settings → Network → Wi‑Fi → Details; Windows → `ipconfig`.)

Restart the Expo dev server after changing `.env` so it picks up the new value.

---

## 4. Run the app

In a **new terminal**, from the **project root**:

```bash
npm start
```

Then press **i** (iOS) or **a** (Android). Use the app and try **Send** — it will call the backend to prepare the tx, sign with Privy in the app, then call the backend again to execute.

---

## 5. Quick checklist

| Step | Command / action                                                                           |
| ---- | ------------------------------------------------------------------------------------------ |
| 1    | `cd backend && npm install && npm run dev` (keep running)                                  |
| 2    | In root `.env`: set `EXPO_PUBLIC_API_URL` (localhost for simulator, machine IP for device) |
| 3    | Restart Expo if it was already running                                                     |
| 4    | From root: `npm start` → press i or a                                                      |
| 5    | In app: Send tokens; backend logs requests in its terminal                                 |

---

## 6. Optional: run both with one command

From the **project root** you can add scripts to run backend and app together (e.g. with `concurrently`). For now, two terminals (one for backend, one for Expo) are enough.

---

## Troubleshooting

- **“Network request failed” or “Prepare failed”**

  - Backend must be running (`cd backend && npm run dev`).
  - On a physical device, use `EXPO_PUBLIC_API_URL=http://YOUR_MACHINE_IP:3001`, not `localhost`.
  - Phone and computer must be on the same Wi‑Fi.

- **Backend not found**

  - Ensure no firewall is blocking port 3001.
  - Try opening `http://localhost:3001` (or `http://YOUR_IP:3001`) in a browser; you should get a 404 for GET (POST routes are correct).

- **CORS**
  - The backend enables CORS for all origins in dev. If you host the backend later, restrict origins as needed.
