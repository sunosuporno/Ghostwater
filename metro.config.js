const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Privy / jose: use browser build so we don't pull in Node's "crypto" (not available in RN)
const resolveRequestWithPackageExports = (context, moduleName, platform) => {
  if (moduleName === 'jose') {
    const ctx = { ...context, unstable_conditionNames: ['browser'] };
    return context.resolveRequest(ctx, moduleName, platform);
  }
  if (moduleName === 'isows') {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return context.resolveRequest(ctx, moduleName, platform);
  }
  if (moduleName.startsWith('zustand')) {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return context.resolveRequest(ctx, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.resolveRequest = resolveRequestWithPackageExports;

module.exports = config;
