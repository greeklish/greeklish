import { loadConfig } from "./config.js";

const config = loadConfig();

let workingProxies = [];
let intervalId = null;
let initialFetchPromise = null;
let dynamicBlacklist = new Map();
let lastProxyCount = -1;

class ProxyHealthTracker {
  constructor() {
    this.healthScores = new Map();
    this.usageStats = new Map();
  }

  recordSuccess(port) {
    const health = this.healthScores.get(port) || {
      score: 100,
      failures: 0,
      successes: 0,
      totalRequests: 0,
      lastCheck: Date.now(),
    };

    health.successes += 1;
    health.totalRequests += 1;
    health.score = Math.min(100, health.score + 5);
    health.lastCheck = Date.now();
    this.healthScores.set(port, health);

    const usage = this.usageStats.get(port) || { lastUsed: 0, useCount: 0 };
    usage.lastUsed = Date.now();
    usage.useCount += 1;
    this.usageStats.set(port, usage);
  }

  recordFailure(port, severity = "medium") {
    const health = this.healthScores.get(port) || {
      score: 100,
      failures: 0,
      successes: 0,
      totalRequests: 0,
      lastCheck: Date.now(),
    };

    const penalty =
      severity === "critical" ? 30 : severity === "high" ? 20 : 10;

    health.failures += 1;
    health.totalRequests += 1;
    health.score = Math.max(0, health.score - penalty);
    health.lastCheck = Date.now();
    this.healthScores.set(port, health);
  }

  getHealthScore(port) {
    return this.healthScores.get(port)?.score ?? 100;
  }

  cleanup(maxAgeMs = 3_600_000) {
    const now = Date.now();

    for (const [port, health] of this.healthScores.entries()) {
      if (now - health.lastCheck > maxAgeMs) {
        this.healthScores.delete(port);
      }
    }

    for (const [port, usage] of this.usageStats.entries()) {
      if (now - usage.lastUsed > maxAgeMs) {
        this.usageStats.delete(port);
      }
    }
  }
}

const proxyHealthTracker = new ProxyHealthTracker();
const activeProxyUsage = new Map();

const PROXY_BLACKLIST_CONFIG = {
  default: {
    patterns: [],
    blacklistDuration: 180_000,
  },
  reddit: {
    patterns: [],
    blacklistDuration: 180_000,
  },
};

export function initProxyManager(intervalMs = config.proxyRefreshIntervalMs) {
  if (!config.proxyFarmUrl || !config.useBrowserProxies) {
    return;
  }

  if (intervalId) {
    return;
  }

  initialFetchPromise = fetchProxies();
  intervalId = setInterval(fetchProxies, intervalMs);
}

export async function waitForInitialProxyLoad(timeoutMs = 3_000) {
  if (!initialFetchPromise) {
    return;
  }

  await Promise.race([
    initialFetchPromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function stopProxyManager() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function getWorkingProxies() {
  return [...workingProxies];
}

export function getProxyByDescription(description) {
  if (!description) {
    return null;
  }

  const searchTerm = description.toLowerCase().trim();
  return (
    workingProxies.find(
      (proxy) => proxy.description?.toLowerCase() === searchTerm
    ) ?? null
  );
}

export function markProxyInUse(proxy, context = "default") {
  if (!proxy?.port) {
    return;
  }

  activeProxyUsage.set(proxy.port, {
    description: proxy.description,
    startTime: Date.now(),
    context,
  });
}

export function markProxyFree(proxy) {
  if (!proxy?.port) {
    return;
  }

  activeProxyUsage.delete(proxy.port);
}

export function blacklistProxy(port, durationMs = null, context = "default") {
  const duration = durationMs ?? getBlacklistDuration(context);
  dynamicBlacklist.set(port, Date.now() + duration);
}

export function recordProxySuccess(port) {
  proxyHealthTracker.recordSuccess(port);
}

export function recordProxyFailure(port, severity = "medium") {
  proxyHealthTracker.recordFailure(port, severity);
}

export function getProxyDirName(proxy) {
  if (!proxy?.description || !proxy?.port) {
    return null;
  }

  const sanitized = proxy.description.toLowerCase().replace(/\s+/g, "-");
  return `${sanitized}-${proxy.port}`;
}

export function hasAvailableProxy(options = {}) {
  return getAvailableProxies(options).length > 0;
}

export function getNextWorkingProxy(options = {}) {
  const availableProxies = getAvailableProxies(options);
  if (availableProxies.length === 0) {
    return null;
  }

  const sorted = [...availableProxies].sort((left, right) => {
    const leftHealth = proxyHealthTracker.getHealthScore(left.port);
    const rightHealth = proxyHealthTracker.getHealthScore(right.port);

    const leftLatencyScore = Math.max(0, 100 - (Number(left.latency || 0) / 10));
    const rightLatencyScore = Math.max(0, 100 - (Number(right.latency || 0) / 10));

    const leftScore = leftHealth * 0.7 + leftLatencyScore * 0.3;
    const rightScore = rightHealth * 0.7 + rightLatencyScore * 0.3;

    return rightScore - leftScore;
  });

  const selected = sorted[0];
  activeProxyUsage.set(selected.port, {
    description: selected.description,
    startTime: Date.now(),
    context: options.context || "default",
    temporary: true,
  });
  return selected;
}

export function getProxyPoolStatus(options = {}) {
  const available = [];
  const busy = [];
  const blacklisted = [];

  for (const proxy of workingProxies) {
    if (isProxyFiltered(proxy, options)) {
      blacklisted.push(proxy.description);
      continue;
    }

    if (activeProxyUsage.has(proxy.port)) {
      busy.push(proxy.description);
    } else {
      available.push(proxy.description);
    }
  }

  return {
    total: available.length + busy.length,
    available: available.length,
    busy: busy.length,
    blacklisted: blacklisted.length,
    availableProxies: available,
    busyProxies: busy,
    blacklistedProxies: blacklisted,
  };
}

function getAvailableProxies(options = {}) {
  return workingProxies.filter((proxy) => !isProxyFiltered(proxy, options));
}

function isProxyFiltered(
  proxy,
  { context = "default", misbehavingContexts = [], siteBlockedContexts = [] } = {}
) {
  if (isProxyBlacklisted(proxy.port)) {
    return true;
  }

  if (activeProxyUsage.has(proxy.port)) {
    return true;
  }

  const description = String(proxy.description || "").toLowerCase();
  const patterns = getBlacklistPatterns(context);
  if (patterns.some((pattern) => description.includes(pattern.toLowerCase()))) {
    return true;
  }

  const contextName = getProxyDirName(proxy);
  if (contextName && misbehavingContexts.includes(contextName)) {
    return true;
  }

  if (contextName && siteBlockedContexts.includes(contextName)) {
    return true;
  }

  return false;
}

function getBlacklistPatterns(context) {
  const defaultPatterns = PROXY_BLACKLIST_CONFIG.default?.patterns || [];
  const contextPatterns = PROXY_BLACKLIST_CONFIG[context]?.patterns || [];
  return [...new Set([...defaultPatterns, ...contextPatterns])];
}

function getBlacklistDuration(context) {
  return (
    PROXY_BLACKLIST_CONFIG[context]?.blacklistDuration ??
    PROXY_BLACKLIST_CONFIG.default?.blacklistDuration ??
    180_000
  );
}

function isProxyBlacklisted(port) {
  const until = dynamicBlacklist.get(port);
  if (!until) {
    return false;
  }

  if (Date.now() < until) {
    return true;
  }

  dynamicBlacklist.delete(port);
  return false;
}

async function fetchProxies() {
  if (!config.proxyFarmUrl) {
    return;
  }

  try {
    const response = await fetch(config.proxyFarmUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch proxies: ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.working)) {
      throw new Error("Proxy farm response missing working[]");
    }

    workingProxies = payload.working;
    if (workingProxies.length !== lastProxyCount) {
      console.log(`[proxy-manager] ${workingProxies.length} working proxies loaded`);
      lastProxyCount = workingProxies.length;
    }

    proxyHealthTracker.cleanup();
  } catch (error) {
    console.warn(`[proxy-manager] ${error.message}`);
  }
}
