import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(projectRoot, ".env") });

let cachedConfig = null;

export function loadConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  const config = {
    backendTargetMode: choice("BACKEND_TARGET_MODE", "local", [
      "local",
      "remote",
      "both",
    ]),
    backendBaseUrl: optional("BACKEND_BASE_URL"),
    backendInternalApiToken: optional("BACKEND_INTERNAL_API_TOKEN"),
    backendRemoteBaseUrl:
      optional("BACKEND_REMOTE_BASE_URL") ||
      firstListEntry("BACKEND_EXTRA_BASE_URLS"),
    backendRemoteInternalApiToken:
      optional("BACKEND_REMOTE_INTERNAL_API_TOKEN") ||
      firstListEntry("BACKEND_EXTRA_INTERNAL_API_TOKENS"),
    proxyFarmUrl: optional("PROXY_FARM_URL"),
    maxBrowsers: integer("MAX_BROWSERS", 2),
    browserTimeoutMs: integer("BROWSER_TIMEOUT_MS", 300_000),
    browserInitTimeoutMs: integer("BROWSER_INIT_TIMEOUT_MS", 30_000),
    queueTimeoutMs: integer("QUEUE_TIMEOUT_MS", 60_000),
    proxyRefreshIntervalMs: integer("PROXY_REFRESH_INTERVAL_MS", 60_000),
    redditRisingRefreshMinMs: integer(
      "R_GREECE_RISING_REFRESH_MIN_MS",
      300_000,
    ),
    redditRisingRefreshMaxMs: integer(
      "R_GREECE_RISING_REFRESH_MAX_MS",
      600_000,
    ),
    xTrendsRefreshMinMs: integer("X_TRENDS_REFRESH_MIN_MS", 300_000),
    xTrendsRefreshMaxMs: integer("X_TRENDS_REFRESH_MAX_MS", 600_000),
    xTrendsMinReadyCount: integer("X_TRENDS_MIN_READY_COUNT", 10),
    xTrendsMaxScrolls: integer("X_TRENDS_MAX_SCROLLS", 20),
    insomniaTopicsRefreshMinMs: integer(
      "INSOMNIA_TOPICS_REFRESH_MIN_MS",
      300_000,
    ),
    insomniaTopicsRefreshMaxMs: integer(
      "INSOMNIA_TOPICS_REFRESH_MAX_MS",
      600_000,
    ),
    myphoneTopicsRefreshMinMs: integer(
      "MYPHONE_TOPICS_REFRESH_MIN_MS",
      300_000,
    ),
    myphoneTopicsRefreshMaxMs: integer(
      "MYPHONE_TOPICS_REFRESH_MAX_MS",
      600_000,
    ),
    myphoneTopicsMinReadyCount: integer("MYPHONE_TOPICS_MIN_READY_COUNT", 20),
    myphoneTopicsMaxLoadMoreClicks: integer(
      "MYPHONE_TOPICS_MAX_LOAD_MORE_CLICKS",
      integer("MYPHONE_TOPICS_MAX_CHANGE_TIME_PAGES", 5),
    ),
    phorumTopicsRefreshMinMs: integer("PHORUM_TOPICS_REFRESH_MIN_MS", 300_000),
    phorumTopicsRefreshMaxMs: integer("PHORUM_TOPICS_REFRESH_MAX_MS", 600_000),
    adslgrTopicsRefreshMinMs: integer("ADSLGR_TOPICS_REFRESH_MIN_MS", 300_000),
    adslgrTopicsRefreshMaxMs: integer("ADSLGR_TOPICS_REFRESH_MAX_MS", 600_000),
    adslgrTopicsMinReadyCount: integer("ADSLGR_TOPICS_MIN_READY_COUNT", 20),
    adslgrTopicsMaxLoadMoreClicks: integer(
      "ADSLGR_TOPICS_MAX_LOAD_MORE_CLICKS",
      5,
    ),
    lagonikaOffersRefreshMinMs: integer(
      "LAGONIKA_OFFERS_REFRESH_MIN_MS",
      300_000,
    ),
    lagonikaOffersRefreshMaxMs: integer(
      "LAGONIKA_OFFERS_REFRESH_MAX_MS",
      600_000,
    ),
    insomniaAuthEmail: optional("INSOMNIA_AUTH_EMAIL"),
    insomniaAuthPassword: optional("INSOMNIA_AUTH_PASSWORD"),
    debugMode: boolean("DEBUG_MODE", false),
    crawlerDirectConnection: boolean("CRAWLER_DIRECT_CONNECTION", false),
    headless: boolean("HEADLESS", false),
    skipNavigationDelays: boolean("SKIP_NAVIGATION_DELAYS", false),
    spawnBrowserWithProxy: optional("SPAWN_BROWSER_WITH_PROXY"),
    backendOutboxRoot: path.join(projectRoot, "runtime-data", "backend-outbox"),
    browserDataRoot: path.join(projectRoot, "browser-data"),
    extensionPath: path.join(
      projectRoot,
      "extensions",
      "ddkjiahejlhfcafbddmgiahcphecmpfh",
      "2025.921.2008_0",
    ),
  };

  if (config.maxBrowsers <= 0) {
    throw new Error("MAX_BROWSERS must be a positive integer");
  }

  config.backendTargets = buildBackendTargets(config);

  config.useBrowserProxies =
    !config.debugMode && !config.crawlerDirectConnection;

  if (config.redditRisingRefreshMinMs <= 0) {
    throw new Error(
      "R_GREECE_RISING_REFRESH_MIN_MS must be a positive integer",
    );
  }

  if (config.redditRisingRefreshMaxMs < config.redditRisingRefreshMinMs) {
    throw new Error(
      "R_GREECE_RISING_REFRESH_MAX_MS must be greater than or equal to R_GREECE_RISING_REFRESH_MIN_MS",
    );
  }

  if (config.xTrendsRefreshMinMs <= 0) {
    throw new Error("X_TRENDS_REFRESH_MIN_MS must be a positive integer");
  }

  if (config.xTrendsRefreshMaxMs < config.xTrendsRefreshMinMs) {
    throw new Error(
      "X_TRENDS_REFRESH_MAX_MS must be greater than or equal to X_TRENDS_REFRESH_MIN_MS",
    );
  }

  if (config.xTrendsMinReadyCount <= 0) {
    throw new Error("X_TRENDS_MIN_READY_COUNT must be a positive integer");
  }

  if (config.xTrendsMaxScrolls <= 0) {
    throw new Error("X_TRENDS_MAX_SCROLLS must be a positive integer");
  }

  if (config.insomniaTopicsRefreshMinMs <= 0) {
    throw new Error(
      "INSOMNIA_TOPICS_REFRESH_MIN_MS must be a positive integer",
    );
  }

  if (config.insomniaTopicsRefreshMaxMs < config.insomniaTopicsRefreshMinMs) {
    throw new Error(
      "INSOMNIA_TOPICS_REFRESH_MAX_MS must be greater than or equal to INSOMNIA_TOPICS_REFRESH_MIN_MS",
    );
  }

  if (config.myphoneTopicsRefreshMinMs <= 0) {
    throw new Error(
      "MYPHONE_TOPICS_REFRESH_MIN_MS must be a positive integer",
    );
  }

  if (config.myphoneTopicsRefreshMaxMs < config.myphoneTopicsRefreshMinMs) {
    throw new Error(
      "MYPHONE_TOPICS_REFRESH_MAX_MS must be greater than or equal to MYPHONE_TOPICS_REFRESH_MIN_MS",
    );
  }

  if (config.myphoneTopicsMinReadyCount <= 0) {
    throw new Error("MYPHONE_TOPICS_MIN_READY_COUNT must be a positive integer");
  }

  if (config.myphoneTopicsMaxLoadMoreClicks <= 0) {
    throw new Error(
      "MYPHONE_TOPICS_MAX_LOAD_MORE_CLICKS must be a positive integer",
    );
  }

  if (config.phorumTopicsRefreshMinMs <= 0) {
    throw new Error("PHORUM_TOPICS_REFRESH_MIN_MS must be a positive integer");
  }

  if (config.phorumTopicsRefreshMaxMs < config.phorumTopicsRefreshMinMs) {
    throw new Error(
      "PHORUM_TOPICS_REFRESH_MAX_MS must be greater than or equal to PHORUM_TOPICS_REFRESH_MIN_MS",
    );
  }

  if (config.adslgrTopicsRefreshMinMs <= 0) {
    throw new Error("ADSLGR_TOPICS_REFRESH_MIN_MS must be a positive integer");
  }

  if (config.adslgrTopicsRefreshMaxMs < config.adslgrTopicsRefreshMinMs) {
    throw new Error(
      "ADSLGR_TOPICS_REFRESH_MAX_MS must be greater than or equal to ADSLGR_TOPICS_REFRESH_MIN_MS",
    );
  }

  if (config.adslgrTopicsMinReadyCount <= 0) {
    throw new Error("ADSLGR_TOPICS_MIN_READY_COUNT must be a positive integer");
  }

  if (config.adslgrTopicsMaxLoadMoreClicks <= 0) {
    throw new Error(
      "ADSLGR_TOPICS_MAX_LOAD_MORE_CLICKS must be a positive integer",
    );
  }

  if (config.lagonikaOffersRefreshMinMs <= 0) {
    throw new Error(
      "LAGONIKA_OFFERS_REFRESH_MIN_MS must be a positive integer",
    );
  }

  if (config.lagonikaOffersRefreshMaxMs < config.lagonikaOffersRefreshMinMs) {
    throw new Error(
      "LAGONIKA_OFFERS_REFRESH_MAX_MS must be greater than or equal to LAGONIKA_OFFERS_REFRESH_MIN_MS",
    );
  }

  cachedConfig = config;
  return config;
}

function requiredValue(key, value) {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value.trim();
}

function requiredAnyValue(keys, value) {
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${keys.join(" or ")}`,
    );
  }
  return value.trim();
}

function optional(key) {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function firstListEntry(key) {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    return null;
  }
  return (
    value
      .split(",")
      .map((entry) => entry.trim())
      .find(Boolean) || null
  );
}

function integer(key, fallback) {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be an integer`);
  }
  return parsed;
}

function choice(key, fallback, allowedValues) {
  const value = optional(key) || fallback;
  if (!allowedValues.includes(value)) {
    throw new Error(`${key} must be one of: ${allowedValues.join(", ")}`);
  }
  return value;
}

function boolean(key, fallback) {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`${key} must be either true or false`);
}

function buildBackendTargets(config) {
  const targets = [];

  if (
    config.backendTargetMode === "local" ||
    config.backendTargetMode === "both"
  ) {
    targets.push({
      name: "local",
      baseUrl: requiredValue("BACKEND_BASE_URL", config.backendBaseUrl),
      token: requiredValue(
        "BACKEND_INTERNAL_API_TOKEN",
        config.backendInternalApiToken,
      ),
    });
  }

  if (
    config.backendTargetMode === "remote" ||
    config.backendTargetMode === "both"
  ) {
    targets.push({
      name: "remote",
      baseUrl: requiredAnyValue(
        ["BACKEND_REMOTE_BASE_URL", "BACKEND_EXTRA_BASE_URLS"],
        config.backendRemoteBaseUrl,
      ),
      token: requiredAnyValue(
        [
          "BACKEND_REMOTE_INTERNAL_API_TOKEN",
          "BACKEND_EXTRA_INTERNAL_API_TOKENS",
        ],
        config.backendRemoteInternalApiToken,
      ),
    });
  }

  return targets;
}
