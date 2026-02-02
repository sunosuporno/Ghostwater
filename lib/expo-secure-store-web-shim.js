/**
 * Web-only shim for expo-secure-store. On web the native module is empty so
 * getValueWithKeyAsync/setValueWithKeyAsync don't exist; Privy needs storage.
 * This shim uses localStorage so Privy can store clientId etc. Native uses real expo-secure-store.
 */
const PREFIX = "expo-secure-store:";

function ensureValidKey(key) {
  if (typeof key !== "string" || !/^[\w.-]+$/.test(key)) {
    throw new Error(
      'Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".'
    );
  }
}

function storageKey(key) {
  return PREFIX + key;
}

// Constants (ignored on web; Privy passes keychainAccessible)
const AFTER_FIRST_UNLOCK = 1;
const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 2;
const ALWAYS = 3;
const ALWAYS_THIS_DEVICE_ONLY = 4;
const WHEN_UNLOCKED = 5;
const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 7;

async function getItemAsync(key, options = {}) {
  ensureValidKey(key);
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

async function setItemAsync(key, value, options = {}) {
  ensureValidKey(key);
  if (typeof value !== "string") {
    throw new Error(
      "Invalid value provided to SecureStore. Values must be strings; consider JSON-encoding your values if they are serializable."
    );
  }
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(storageKey(key), value);
}

async function deleteItemAsync(key, options = {}) {
  ensureValidKey(key);
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(storageKey(key));
}

async function isAvailableAsync() {
  return typeof localStorage !== "undefined";
}

function setItem(key, value, options = {}) {
  ensureValidKey(key);
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(storageKey(key), value);
}

function getItem(key, options = {}) {
  ensureValidKey(key);
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(storageKey(key));
}

function canUseBiometricAuthentication() {
  return false;
}

module.exports = {
  AFTER_FIRST_UNLOCK,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  ALWAYS,
  ALWAYS_THIS_DEVICE_ONLY,
  WHEN_UNLOCKED,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
  isAvailableAsync,
  setItem,
  getItem,
  canUseBiometricAuthentication,
};
