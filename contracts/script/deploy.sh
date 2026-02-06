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

if [ -z "${GHOSTWATER_L2_REGISTRY_ADDRESS}" ] || [ "${GHOSTWATER_L2_REGISTRY_ADDRESS}" = "0x0000000000000000000000000000000000000000" ]; then
  echo "Error: Set GHOSTWATER_L2_REGISTRY_ADDRESS in .env (your Durin L2 Registry address)"
  exit 1
fi

if [ -z "${PRIVATE_KEY}" ]; then
  echo "Error: Set PRIVATE_KEY in .env for --broadcast"
  exit 1
fi

# Verify on Basescan after deploy if API key is set (get one at https://basescan.org/myapikey)
VERIFY_OPTS=""
if [ -n "${BASESCAN_API_KEY}" ]; then
  VERIFY_OPTS="--verify"
  echo "Verification enabled (BASESCAN_API_KEY set)."
fi

echo "Deploying GhostwaterRegistrar to Base mainnet..."
forge script script/Deploy.s.sol --rpc-url base --broadcast --private-key "$PRIVATE_KEY" $VERIFY_OPTS

echo ""
echo "Next step: As the L2 Registry owner, call addRegistrar(<deployed address>) on the registry (e.g. via Basescan)."
