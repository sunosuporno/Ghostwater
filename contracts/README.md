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

```bash
forge script script/Deploy.s.sol --rpc-url base --broadcast
# Or with env: --private-key $PRIVATE_KEY
```

After deployment, as the **owner of the L2 Registry**, call:

```text
registry.addRegistrar(<GhostwaterRegistrar address>)
```

(e.g. via Basescan “Write contract” → `addRegistrar`).

## Contract behaviour

- **Free** – no payment; `register(label)` is callable by anyone for themselves.
- **One per address** – each address can claim at most one subdomain; `AlreadyClaimed` otherwise.
- **Immutable** – subnodes are owned by the registrar contract; resolution is set once to the claimer’s address and cannot be changed or transferred.

## Frontend / app

- Use `hasSubdomain(address)` to see if a user has claimed.
- Use `addressToLabel(address)` to show their label (e.g. `alice.yourapp.eth`).
- Use `available(label)` to check before claiming.
