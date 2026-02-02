// Import required polyfills first (required for Privy)
import "@ethersproject/shims";
import "fast-text-encoding";
import "react-native-get-random-values";
// Buffer: needed for send flow (some dep uses it). Load after uuid is resolved via Metro (uuid shim).
import { Buffer } from "buffer";
if (typeof global.Buffer === "undefined") global.Buffer = Buffer;
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
// Then import the expo router
import "expo-router/entry";
