const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Privy / jose: use browser build so we don't pull in Node's "crypto" (not available in RN)
// uuid: Privy's nested uuid@9 uses wrapper.mjs which expects default.v1; on web that resolves to
// ESM browser build with no default → undefined.v1. Force root uuid@7 CJS for web so default export exists.
const resolveRequestWithPackageExports = (context, moduleName, platform) => {
  if (moduleName === "jose") {
    const ctx = { ...context, unstable_conditionNames: ["browser"] };
    return context.resolveRequest(ctx, moduleName, platform);
  }
  if (moduleName === "isows") {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return context.resolveRequest(ctx, moduleName, platform);
  }
  if (moduleName.startsWith("zustand")) {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return context.resolveRequest(ctx, moduleName, platform);
  }
  if (moduleName === "uuid" && platform === "web") {
    const rootUuid = path.resolve(__dirname, "node_modules/uuid/dist/index.js");
    return { type: "sourceFile", filePath: rootUuid };
  }
  // expo-application: on web, applicationId is null but @privy-io/expo requires a string.
  // Use a shim that provides our app's bundle id so web works; native uses real expo-application.
  if (moduleName === "expo-application" && platform === "web") {
    const shim = path.resolve(__dirname, "lib/expo-application-web-shim.js");
    return { type: "sourceFile", filePath: shim };
  }
  // expo-secure-store: on web the native module is empty so getValueWithKeyAsync/setValueWithKeyAsync
  // don't exist; Privy needs storage. Use a shim that backs onto localStorage.
  if (moduleName === "expo-secure-store" && platform === "web") {
    const shim = path.resolve(__dirname, "lib/expo-secure-store-web-shim.js");
    return { type: "sourceFile", filePath: shim };
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.resolveRequest = resolveRequestWithPackageExports;

module.exports = config;
