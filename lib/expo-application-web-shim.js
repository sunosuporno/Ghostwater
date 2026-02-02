/**
 * Web-only shim for expo-application. No require() of expo-application so Metro can bundle it.
 * On web, expo-application gives applicationId = null, but @privy-io/expo requires a string.
 * This file exports the same API with applicationId set to our app's bundle id.
 * Native builds never use this file (metro resolves expo-application to the real package).
 */
const { Platform, UnavailabilityError } = require("expo-modules-core");

const WEB_APP_ID = "com.supornosarkar.Ghostwater";

// expo-application ApplicationReleaseType enum (no require of expo-application)
const ApplicationReleaseType = {
  UNKNOWN: 0,
  SIMULATOR: 1,
  ENTERPRISE: 2,
  DEVELOPMENT: 3,
  AD_HOC: 4,
  APP_STORE: 5,
};

// Same shape as expo-application on web, but applicationId is a string
const nativeApplicationVersion = null;
const nativeBuildVersion = null;
const applicationName = null;
const applicationId = WEB_APP_ID;

function getAndroidId() {
  if (Platform.OS !== "android") {
    throw new UnavailabilityError("expo-application", "androidId");
  }
  throw new UnavailabilityError("expo-application", "androidId");
}

async function getInstallReferrerAsync() {
  throw new UnavailabilityError("expo-application", "getInstallReferrerAsync");
}

async function getIosIdForVendorAsync() {
  throw new UnavailabilityError("expo-application", "getIosIdForVendorAsync");
}

async function getIosApplicationReleaseTypeAsync() {
  throw new UnavailabilityError(
    "expo-application",
    "getApplicationReleaseTypeAsync"
  );
}

async function getIosPushNotificationServiceEnvironmentAsync() {
  throw new UnavailabilityError(
    "expo-application",
    "getPushNotificationServiceEnvironmentAsync"
  );
}

async function getInstallationTimeAsync() {
  return null;
}

async function getLastUpdateTimeAsync() {
  throw new UnavailabilityError("expo-application", "getLastUpdateTimeAsync");
}

module.exports = {
  nativeApplicationVersion,
  nativeBuildVersion,
  applicationName,
  applicationId,
  getAndroidId,
  getInstallReferrerAsync,
  getIosIdForVendorAsync,
  getIosApplicationReleaseTypeAsync,
  getIosPushNotificationServiceEnvironmentAsync,
  getInstallationTimeAsync,
  getLastUpdateTimeAsync,
  ApplicationReleaseType,
};
