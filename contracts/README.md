# Ghostwater ENS L2 Subdomain Registrar

Free, one-per-address, immutable subdomains on Base mainnet via [Durin](https://github.com/namestonehq/durin).

## Prerequisites

1. **Durin registry**  
   At [durin.dev](https://durin.dev): deploy a registry for your ENS name and enable L2 resolution (Base). Note the **L2 Registry** address.

2. **Foundry**  
   [Install Foundry](https://book.getfoundry.sh/getting-started/installation), then from this directory:

   ```bash
   forge install foundry-rs/forge-std --no-commit
   ```

## Setup

```bash
cp .env.example .env
# Edit .env: set L2_REGISTRY_ADDRESS (your Durin L2 registry), BASE_RPC_URL, and PRIVATE_KEY or use --private-key
```

## Build

```bash
forge build
```

## Deploy (Base mainnet)

From the `contracts/` directory:

```bash
./script/deploy.sh
```

Or with forge directly:

```bash
forge script script/Deploy.s.sol --rpc-url base --broadcast --private-key $PRIVATE_KEY
```

After deployment, as the **owner of the L2 Registry**, call:

```text
registry.addRegistrar(<GhostwaterRegistrar address>)
```

(e.g. via Basescan “Write contract” → `addRegistrar`).

## Fork tests (Base mainnet)

To debug `register` / `setPreferences` against the real Base mainnet (and L2 registry), run the fork tests:

1. In `contracts/.env` set:
   - `BASE_RPC_URL` (e.g. `https://mainnet.base.org` or an Alchemy/Infura URL)
   - `GHOSTWATER_REGISTRAR_ADDRESS` – your deployed GhostwaterRegistrar on Base

2. Run (from `contracts/`):

   ```bash
   cd contracts && forge test --match-contract GhostwaterRegistrarFork -vvv
   ```

   Or pass the RPC URL in the command (no need for `BASE_RPC_URL` in .env):

   ```bash
   cd contracts && forge test --match-contract GhostwaterRegistrarFork --fork-url "https://mainnet.base.org" -vvv
   ```

   Use `-vvvv` for more trace if a test reverts. Tests cover: `NotClaimed`, `LabelTooShort`, full flow (register + setPreferences), `AlreadyClaimed`, `LabelUnavailable`, and that the registrar is allowed on the registry. If a label is already taken on mainnet, change the label constant in `test/GhostwaterRegistrarFork.t.sol` (e.g. `testfork999`) and re-run.

## Contract behaviour

- **Free** – no payment; `register(label)` is callable by anyone for themselves.
- **One per address** – each address can claim at most one subdomain; `AlreadyClaimed` otherwise.
- **Immutable** – subnodes are owned by the registrar contract; resolution is set once to the claimer’s address and cannot be changed or transferred.

## Frontend / app

- Use `hasSubdomain(address)` to see if a user has claimed.
- Use `addressToLabel(address)` to show their label (e.g. `alice.yourapp.eth`).
- Use `available(label)` to check before claiming.
