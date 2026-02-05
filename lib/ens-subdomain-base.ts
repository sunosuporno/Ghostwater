/**
 * ENS L2 subdomain (GhostwaterRegistrar + L2 Registry) on Base mainnet.
 * Read state and build register + setPreferences calldata (two txs in sequence).
 */
import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  getContract,
  http,
  type Address,
} from "viem";
import { base } from "viem/chains";

/** Custom errors from GhostwaterRegistrar for friendly messages. */
const REGISTRAR_ERROR_ABI = [
  { name: "AlreadyClaimed", type: "error", inputs: [] },
  { name: "NotClaimed", type: "error", inputs: [] },
  { name: "LabelUnavailable", type: "error", inputs: [] },
  { name: "LabelTooShort", type: "error", inputs: [] },
] as const;

/**
 * Turn contract revert data into a short, user-facing message.
 * Handles GhostwaterRegistrar custom errors and generic "reverted" messages.
 */
export function getRegistrarRevertMessage(revertData: unknown): string | null {
  const hex = typeof revertData === "string" && revertData.startsWith("0x") ? revertData : null;
  if (!hex || hex.length < 10) return null;
  try {
    const decoded = decodeErrorResult({
      abi: [...REGISTRAR_ERROR_ABI],
      data: hex as `0x${string}`,
    });
    const name = decoded.errorName;
    if (name === "AlreadyClaimed") return "This wallet already has a Ghostwater name. Use Edit preferences to change chain/token.";
    if (name === "NotClaimed") return "Claim a name first (above), then you can set or edit preferences.";
    if (name === "LabelUnavailable") return "That name is already taken. Try another.";
    if (name === "LabelTooShort") return "Name must be at least 3 characters.";
    return `Contract error: ${name}`;
  } catch {
    return null;
  }
}

const REGISTRAR_ABI = [
  {
    name: "hasSubdomain",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "addressToLabel",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "string" }],
  },
  {
    name: "addressToNode",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "available",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "registry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "label", type: "string" }],
    outputs: [],
  },
  {
    name: "setPreferences",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "preferredChain", type: "string" },
      { name: "preferredToken", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "registerWithPreferences",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "preferredChain", type: "string" },
      { name: "preferredToken", type: "string" },
    ],
    outputs: [],
  },
] as const;

const REGISTRY_ABI = [
  {
    name: "baseNode",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "names",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "bytes" }],
  },
  {
    name: "decodeName",
    type: "function",
    stateMutability: "pure",
    inputs: [{ name: "name", type: "bytes" }],
    outputs: [{ type: "string" }],
  },
  {
    name: "makeNode",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { name: "parentNode", type: "bytes32" },
      { name: "label", type: "string" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ type: "string" }],
  },
] as const;

/** ENS text record keys used by GhostwaterRegistrar for preferences. */
export const PREFERRED_CHAIN_KEY = "com.ghostwater.preferredChain";
export const PREFERRED_TOKEN_KEY = "com.ghostwater.preferredToken";

function getBaseRpcUrl(): string {
  if (process.env.EXPO_PUBLIC_BASE_RPC_URL) return process.env.EXPO_PUBLIC_BASE_RPC_URL;
  const alchemyKey = process.env.EXPO_PUBLIC_ALCHEMY_API_KEY_BASE_MAINNET ?? process.env.EXPO_PUBLIC_ALCHEMY_API_KEY;
  if (alchemyKey) return `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`;
  return "https://mainnet.base.org";
}

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(getBaseRpcUrl()),
  });
}

export type SubdomainStatus = {
  hasSubdomain: boolean;
  label: string | null;
  baseName: string | null;
  fullName: string | null;
  /** Preferred chain name (e.g. "Base", "Arbitrum") from ENS text record. */
  preferredChain: string | null;
  /** Preferred token symbol or contract address from ENS text record. */
  preferredToken: string | null;
};

/**
 * Fetch whether the address has a subdomain, its label, and the registry base name (e.g. ghostwater.eth).
 */
export async function fetchSubdomainStatus(
  registrarAddress: Address,
  userAddress: Address
): Promise<SubdomainStatus> {
  const client = getPublicClient();
  const registrar = getContract({
    address: registrarAddress,
    abi: REGISTRAR_ABI,
    client,
  });

  const [hasSubdomain, label, node] = await Promise.all([
    registrar.read.hasSubdomain([userAddress]),
    registrar.read.addressToLabel([userAddress]),
    registrar.read.addressToNode([userAddress]),
  ]);

  const registrarRegistryAddress = (await registrar.read.registry()) as Address;
  const registryForBase = getContract({
    address: registrarRegistryAddress,
    abi: REGISTRY_ABI,
    client,
  });

  let baseName: string | null = null;
  try {
    const baseNode = await registryForBase.read.baseNode();
    const nameBytes = await registryForBase.read.names([baseNode]);
    baseName = await registryForBase.read.decodeName([nameBytes]);
  } catch {
    // ignore
  }

  const zeroNodeHex = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
  const hasNode =
    node != null &&
    (typeof node === "string" ? node !== zeroNodeHex : (node as bigint) !== 0n);
  const fullName =
    hasSubdomain && label && label.length > 0
      ? baseName
        ? `${label}.${baseName}`
        : label
      : null;

  let preferredChain: string | null = null;
  let preferredToken: string | null = null;
  const registryForTextAddress = getL2RegistryAddress() ?? registrarRegistryAddress;
  const registryForText = getContract({
    address: registryForTextAddress,
    abi: REGISTRY_ABI,
    client,
  });
  if (hasSubdomain && hasNode) {
    try {
      const [chainVal, tokenVal] = await Promise.all([
        registryForText.read.text([node, PREFERRED_CHAIN_KEY]),
        registryForText.read.text([node, PREFERRED_TOKEN_KEY]),
      ]);
      preferredChain = chainVal && chainVal.length > 0 ? chainVal : null;
      preferredToken = tokenVal && tokenVal.length > 0 ? tokenVal : null;
    } catch {
      // text records may not exist or registry may not support text()
    }
  }

  return {
    hasSubdomain: hasSubdomain && label != null && label.length > 0,
    label: label && label.length > 0 ? label : null,
    baseName,
    fullName,
    preferredChain,
    preferredToken,
  };
}

/**
 * Check if a label is available for registration.
 */
export async function checkLabelAvailable(
  registrarAddress: Address,
  label: string
): Promise<boolean> {
  const client = getPublicClient();
  const registrar = getContract({
    address: registrarAddress,
    abi: REGISTRAR_ABI,
    client,
  });
  return registrar.read.available([label]);
}

/**
 * Build calldata for register(label). Send this tx first.
 */
export function getRegisterCalldata(label: string): `0x${string}` {
  return encodeFunctionData({
    abi: REGISTRAR_ABI,
    functionName: "register",
    args: [label],
  });
}

/**
 * Build calldata for setPreferences(preferredChain, preferredToken). Use when user already has a subdomain (edit flow).
 */
export function getSetPreferencesCalldata(
  preferredChain: string,
  preferredToken: string
): `0x${string}` {
  return encodeFunctionData({
    abi: REGISTRAR_ABI,
    functionName: "setPreferences",
    args: [preferredChain, preferredToken],
  });
}

/**
 * Build calldata for registerWithPreferences(label, preferredChain, preferredToken). One tx to claim name and set preferences.
 */
export function getRegisterWithPreferencesCalldata(
  label: string,
  preferredChain: string,
  preferredToken: string
): `0x${string}` {
  return encodeFunctionData({
    abi: REGISTRAR_ABI,
    functionName: "registerWithPreferences",
    args: [label, preferredChain, preferredToken],
  });
}

export function getRegistrarAddress(): Address | null {
  const addr = process.env.EXPO_PUBLIC_GHOSTWATER_REGISTRAR_ADDRESS;
  if (!addr || !addr.startsWith("0x")) return null;
  return addr as Address;
}

/** L2 Registry address (for reading text records). Prefer env so we read from the same registry the registrar uses. */
export function getL2RegistryAddress(): Address | null {
  const addr = process.env.EXPO_PUBLIC_L2_REGISTRY_ADDRESS;
  if (!addr || !addr.startsWith("0x")) return null;
  return addr as Address;
}
