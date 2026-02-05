#!/usr/bin/env bash
set -e

# Run from repo root (contracts/)
cd "$(dirname "$0")/.."

# Load .env if present (Foundry also loads it; this ensures PRIVATE_KEY is set for the script)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${L2_REGISTRY_ADDRESS}" ] || [ "${L2_REGISTRY_ADDRESS}" = "0x0000000000000000000000000000000000000000" ]; then
  echo "Error: Set L2_REGISTRY_ADDRESS in .env (your Durin L2 Registry address)"
  exit 1
fi

if [ -z "${PRIVATE_KEY}" ]; then
  echo "Error: Set PRIVATE_KEY in .env for --broadcast"
  exit 1
fi

echo "Deploying GhostwaterRegistrar to Base mainnet..."
forge script script/Deploy.s.sol --rpc-url base --broadcast --private-key "$PRIVATE_KEY"

echo ""
echo "Next step: As the L2 Registry owner, call addRegistrar(<deployed address>) on the registry (e.g. via Basescan)."
