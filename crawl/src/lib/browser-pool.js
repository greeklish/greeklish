import {
  cleanupAllBrowserData,
  closeAllBrowsers,
  closeBrowser as closeManagedBrowser,
  createPageUnavailableWatcher,
  initBrowser,
} from "./browser.js";
import { loadConfig } from "./config.js";
import {
  blacklistProxy,
  getNextWorkingProxy,
  getProxyDirName,
  hasAvailableProxy,
  markProxyFree,
} from "./proxy-manager.js";

const config = loadConfig();

export class BrowserPool {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || config.maxBrowsers;
    this.browserTimeout = options.browserTimeout || config.browserTimeoutMs;
    this.initTimeout = options.initTimeout || config.browserInitTimeoutMs;
    this.queueTimeout = options.queueTimeout || config.queueTimeoutMs;
    this.misbehaviorWindow = options.misbehaviorWindow || 60_000;
    this.maxFailuresInWindow = options.maxFailuresInWindow || 3;
    this.misbehaviorExclusionPeriod =
      options.misbehaviorExclusionPeriod || 180_000;
    this.siteBlockExpirationPeriod =
      options.siteBlockExpirationPeriod || 600_000;

    this.browsers = new Map();
    this.failureTracking = new Map();
    this.totalFailureCounts = new Map();
    this.misbehavingContexts = new Map();
    this.siteBlockedContexts = new Map();
    this.jobQueue = [];
    this.cooldowns = new Map();
    this.recentBrowserFailures = [];
    this.scheduledProcessQueue = null;
    this.isProcessingQueue = false;
    this.lastProcessQueueCall = 0;
    this.processQueueMinInterval = 100;
  }

  async acquireBrowser(
    jobFn,
    {
      jobId = null,
      signal = null,
      site = null,
      queueTimeout = this.queueTimeout,
      preferLeastFailures = false,
    } = {}
  ) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }

      const job = {
        id: jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fn: jobFn,
        resolve,
        reject,
        signal,
        site,
        createdAt: Date.now(),
        options: { preferLeastFailures },
      };

      let timeoutId = null;
      if (queueTimeout !== null) {
        timeoutId = setTimeout(() => {
          const index = this.jobQueue.indexOf(job);
          if (index >= 0) {
            this.jobQueue.splice(index, 1);
            reject(
              new Error(
                `Browser acquisition timeout after ${Math.round(
                  (Date.now() - job.createdAt) / 1000
                )}s in queue`
              )
            );
          }
        }, queueTimeout);
      }

      const onAbort = () => {
        const index = this.jobQueue.indexOf(job);
        if (index >= 0) {
          this.jobQueue.splice(index, 1);
        }
        clearTimeout(timeoutId);
        reject(new Error("Operation aborted"));
      };

      signal?.addEventListener("abort", onAbort);

      const originalResolve = job.resolve;
      job.resolve = (result) => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        originalResolve(result);
      };

      const originalReject = job.reject;
      job.reject = (error) => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        originalReject(error);
      };

      this.jobQueue.push(job);
      this.processQueue();
    });
  }

  async executeWithConcurrency(limit, operation) {
    const original = this.maxConcurrent;
    this.maxConcurrent = limit;
    try {
      return await operation();
    } finally {
      this.maxConcurrent = original;
      this.processQueue();
    }
  }

  markSiteBlocked(contextName, site) {
    const siteBlocks = this.siteBlockedContexts.get(contextName) || {};
    siteBlocks[site] = Date.now();
    this.siteBlockedContexts.set(contextName, siteBlocks);
  }

  getSiteBlockedContexts(site) {
    const blocked = [];
    for (const [contextName, siteBlocks] of this.siteBlockedContexts.entries()) {
      if (siteBlocks[site] && !this.hasSiteBlockExpired(siteBlocks[site])) {
        blocked.push(contextName);
      }
    }
    return blocked;
  }

  getMisbehavingContexts() {
    const now = Date.now();
    const result = [];

    for (const [contextName, markedAt] of this.misbehavingContexts.entries()) {
      if (now - markedAt <= this.misbehaviorExclusionPeriod) {
        result.push(contextName);
      } else {
        this.misbehavingContexts.delete(contextName);
      }
    }

    return result;
  }

  async cleanupIdleBrowsers() {
    const closers = [];
    for (const [contextName, browserInfo] of this.browsers.entries()) {
      if (browserInfo.state === "available") {
        closers.push(this.closeBrowser(contextName));
      }
    }
    await Promise.allSettled(closers);
  }

  async shutdown() {
    for (const [contextName] of this.browsers.entries()) {
      await this.closeBrowser(contextName, true);
    }
    await closeAllBrowsers();
    await cleanupAllBrowserData();
  }

  getStatus() {
    const states = { initializing: 0, available: 0, busy: 0 };
    for (const browserInfo of this.browsers.values()) {
      states[browserInfo.state] += 1;
    }

    return {
      total: this.browsers.size,
      maxConcurrent: this.maxConcurrent,
      queueLength: this.jobQueue.length,
      states,
      misbehavingContexts: this.getMisbehavingContexts(),
      cooldowns: this.getActiveCooldowns(),
    };
  }

  async processQueue() {
    const now = Date.now();
    if (this.isProcessingQueue) {
      return;
    }

    const elapsed = now - this.lastProcessQueueCall;
    if (elapsed < this.processQueueMinInterval) {
      if (this.jobQueue.length > 0 && !this.scheduledProcessQueue) {
        this.scheduledProcessQueue = setTimeout(() => {
          this.scheduledProcessQueue = null;
          this.processQueue();
        }, this.processQueueMinInterval - elapsed);
      }
      return;
    }

    this.lastProcessQueueCall = now;
    if (this.jobQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.jobQueue.length > 0) {
        let assignedExistingBrowser = false;

        for (let index = 0; index < this.jobQueue.length; index += 1) {
          const queuedJob = this.jobQueue[index];
          if (queuedJob.signal?.aborted) {
            this.jobQueue.splice(index, 1);
            queuedJob.reject(new Error("Operation aborted before starting"));
            index -= 1;
            continue;
          }

          const browser = this.getAvailableBrowser(
            queuedJob.site,
            queuedJob.options
          );
          if (browser) {
            this.jobQueue.splice(index, 1);
            this.assignJob(browser, queuedJob);
            assignedExistingBrowser = true;
            break;
          }
        }

        if (assignedExistingBrowser) {
          continue;
        }

        if (this.getActiveCooldown()) {
          break;
        }

        const initializingCount = Array.from(this.browsers.values()).filter(
          (browser) => browser.state === "initializing"
        ).length;
        const misbehavingContexts = this.getMisbehavingContexts();
        const effectiveMaxConcurrent = Math.max(
          1,
          this.maxConcurrent - misbehavingContexts.length
        );

        if (
          this.browsers.size >= effectiveMaxConcurrent ||
          initializingCount >= 2
        ) {
          setTimeout(() => this.processQueue(), 1_000);
          break;
        }

        let selectedJobIndex = -1;
        for (let index = 0; index < this.jobQueue.length; index += 1) {
          const queuedJob = this.jobQueue[index];
          if (queuedJob.signal?.aborted) {
            this.jobQueue.splice(index, 1);
            queuedJob.reject(new Error("Operation aborted before starting"));
            index -= 1;
            continue;
          }

          if (!config.useBrowserProxies) {
            selectedJobIndex = index;
            break;
          }

          const siteBlockedContexts = queuedJob.site
            ? this.getSiteBlockedContexts(queuedJob.site)
            : [];
          if (
            hasAvailableProxy({
              context: queuedJob.site,
              misbehavingContexts,
              siteBlockedContexts,
            })
          ) {
            selectedJobIndex = index;
            break;
          }
        }

        if (selectedJobIndex === -1) {
          this.setCooldown("no_proxy", 5_000);
          setTimeout(() => this.processQueue(), 5_000);
          break;
        }

        const job = this.jobQueue.splice(selectedJobIndex, 1)[0];
        if (!config.useBrowserProxies) {
          const directPrefix = config.debugMode ? "debug" : "direct";
          const existingDirectNumbers = Array.from(this.browsers.keys())
            .filter((name) => name.startsWith(`${directPrefix}-`))
            .map((name) => Number.parseInt(name.split("-")[1], 10))
            .filter(Number.isFinite);

          const nextDirectNum =
            existingDirectNumbers.length > 0
              ? Math.max(...existingDirectNumbers) + 1
              : 1;

          this.createAndAssignBrowser(job, {
            port: null,
            description: `${directPrefix}-${nextDirectNum}`,
          });
          continue;
        }

        const siteBlockedContexts = job.site
          ? this.getSiteBlockedContexts(job.site)
          : [];
        const proxy = getNextWorkingProxy({
          context: job.site,
          misbehavingContexts,
          siteBlockedContexts,
        });

        if (!proxy) {
          this.jobQueue.splice(selectedJobIndex, 0, job);
          this.setCooldown("no_proxy", 5_000);
          setTimeout(() => this.processQueue(), 5_000);
          break;
        }

        this.createAndAssignBrowser(job, proxy);
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  getAvailableBrowser(site = null, options = {}) {
    const preferLeastFailures = Boolean(options.preferLeastFailures);
    const candidates = [];

    for (const [contextName, browserInfo] of this.browsers.entries()) {
      if (browserInfo.state !== "available") {
        continue;
      }

      if (site && this.isSiteBlocked(contextName, site)) {
        continue;
      }

      if (!preferLeastFailures) {
        return { contextName, ...browserInfo };
      }

      candidates.push({
        contextName,
        browserInfo,
        failureCount: this.totalFailureCounts.get(contextName) || 0,
      });
    }

    if (!preferLeastFailures || candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      if (left.failureCount !== right.failureCount) {
        return left.failureCount - right.failureCount;
      }
      return (left.browserInfo.lastUsed || 0) - (right.browserInfo.lastUsed || 0);
    });

    const selected = candidates[0];
    return { contextName: selected.contextName, ...selected.browserInfo };
  }

  async createAndAssignBrowser(job, proxyObj) {
    const proxyUrl = proxyObj.port ? `socks5://127.0.0.1:${proxyObj.port}` : null;
    const userDataDir = proxyObj.port
      ? getProxyDirName(proxyObj)
      : proxyObj.description;
    const contextName =
      userDataDir ||
      `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (this.browsers.has(contextName)) {
      this.jobQueue.unshift(job);
      return;
    }

    try {
      this.browsers.set(contextName, {
        state: "initializing",
        proxy: proxyObj,
        proxyUrl,
        lastUsed: Date.now(),
        timeoutId: null,
      });

      const page = await Promise.race([
        initBrowser(contextName, {
          withProxy: config.useBrowserProxies,
          debugMode: config.debugMode,
          configureForScraping: true,
          proxyUrl,
          userDataDir,
          quiet: true,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Browser initialization timeout")),
            this.initTimeout
          )
        ),
      ]);

      if (page.isClosed()) {
        throw new Error("Page was closed immediately after initialization");
      }

      const browserInfo = {
        page,
        state: "busy",
        proxy: proxyObj,
        proxyUrl,
        lastUsed: Date.now(),
        timeoutId: null,
        initTime: Date.now(),
      };

      this.browsers.set(contextName, browserInfo);
      await this.assignJob({ contextName, ...browserInfo }, job);
      setTimeout(() => this.processQueue(), 100);
    } catch (error) {
      const isConnectivityFailure = /No internet connectivity/i.test(
        error.message
      );

      if (isConnectivityFailure && proxyObj?.port) {
        blacklistProxy(proxyObj.port, 180_000, job.site || "default");
      }

      this.recordBrowserFailure(contextName);

      const browserInfo = this.browsers.get(contextName);
      if (browserInfo?.proxy) {
        markProxyFree(browserInfo.proxy);
      }

      await this.closeBrowser(contextName).catch(() => {});
      this.browsers.delete(contextName);
      job.reject(error);

      const shouldPause =
        !isConnectivityFailure && this.recordBrowserInitFailure();
      if (shouldPause) {
        this.setCooldown("browser_init_failure", 10_000);
        setTimeout(() => this.processQueue(), 10_000);
      } else {
        setTimeout(() => this.processQueue(), 1_000);
      }
    }
  }

  async assignJob(browserInfo, job) {
    const { contextName, page } = browserInfo;
    let isFaulty = false;
    let jobTimeoutId = null;
    let pageUnavailableWatcher = null;

    const currentBrowserInfo = this.browsers.get(contextName);
    if (!currentBrowserInfo) {
      job.reject(new Error("Browser no longer exists in pool"));
      return;
    }

    if (currentBrowserInfo.timeoutId) {
      clearTimeout(currentBrowserInfo.timeoutId);
    }

    currentBrowserInfo.state = "busy";
    currentBrowserInfo.lastUsed = Date.now();
    currentBrowserInfo.timeoutId = null;
    this.browsers.set(contextName, currentBrowserInfo);

    try {
      if (page.isClosed()) {
        throw new Error("Browser no longer accessible");
      }

      const timeoutPromise = new Promise((_, reject) => {
        jobTimeoutId = setTimeout(() => {
          reject(new Error("Job execution timeout after 30s"));
        }, 30_000);
      });
      pageUnavailableWatcher = createPageUnavailableWatcher(page);
      const pageUnavailablePromise = pageUnavailableWatcher.promise.then(
        (result) => {
          throw new Error(`Browser page unavailable: ${result.type}`);
        }
      );

      const result = await Promise.race([
        job.fn(page, contextName, job.signal),
        timeoutPromise,
        pageUnavailablePromise,
      ]);

      clearTimeout(jobTimeoutId);
      job.resolve(result);
    } catch (error) {
      if (jobTimeoutId) {
        clearTimeout(jobTimeoutId);
      }

      const browserState = this.browsers.get(contextName);
      const timeSinceInit = browserState?.initTime
        ? Date.now() - browserState.initTime
        : 0;

      if (browserState?.initTime && timeSinceInit < 60_000) {
        this.recordBrowserFailure(contextName);
        isFaulty = true;
        await this.closeBrowser(contextName);
      } else {
        const isBrowserError =
          /ERR_|Target closed|Page has been closed|Page crashed|Browser page unavailable|no longer accessible|timeout|crash/i.test(
            error.message
          );

        if (isBrowserError) {
          this.recordBrowserFailure(contextName);
          isFaulty = true;
          await this.closeBrowser(contextName);
        }
      }

      job.reject(error);
    } finally {
      if (jobTimeoutId) {
        clearTimeout(jobTimeoutId);
      }
      pageUnavailableWatcher?.dispose();

      if (!isFaulty) {
        const browserState = this.browsers.get(contextName);
        if (browserState) {
          browserState.state = "available";
          browserState.lastUsed = Date.now();
          browserState.initTime = null;
          browserState.timeoutId = this.scheduleCleanup(contextName);
          this.browsers.set(contextName, browserState);
        }
      }
      setTimeout(() => this.processQueue(), 100);
    }
  }

  scheduleCleanup(contextName) {
    return setTimeout(() => {
      const browserInfo = this.browsers.get(contextName);
      if (browserInfo?.state === "available") {
        this.closeBrowser(contextName).catch(() => {});
      }
    }, this.browserTimeout);
  }

  async closeBrowser(contextName, isShutdown = false) {
    const browserInfo = this.browsers.get(contextName);
    if (!browserInfo) {
      return;
    }

    if (browserInfo.timeoutId) {
      clearTimeout(browserInfo.timeoutId);
    }

    if (browserInfo.proxy) {
      markProxyFree(browserInfo.proxy);
    }

    await closeManagedBrowser(contextName, isShutdown);
    this.browsers.delete(contextName);
  }

  recordBrowserFailure(contextName) {
    const now = Date.now();
    const history = this.failureTracking.get(contextName) || [];
    const nextHistory = [...history, now].filter(
      (timestamp) => now - timestamp <= this.misbehaviorWindow
    );
    this.failureTracking.set(contextName, nextHistory);
    this.totalFailureCounts.set(
      contextName,
      (this.totalFailureCounts.get(contextName) || 0) + 1
    );

    if (nextHistory.length >= this.maxFailuresInWindow) {
      this.misbehavingContexts.set(contextName, now);
      return true;
    }

    return false;
  }

  recordBrowserInitFailure() {
    const now = Date.now();
    this.recentBrowserFailures.push(now);
    this.recentBrowserFailures = this.recentBrowserFailures.filter(
      (timestamp) => now - timestamp <= 10_000
    );
    return this.recentBrowserFailures.length >= 3;
  }

  setCooldown(type, durationMs) {
    this.cooldowns.set(type, Date.now() + durationMs);
  }

  getActiveCooldown() {
    const now = Date.now();
    for (const [type, until] of this.cooldowns.entries()) {
      if (now < until) {
        return type;
      }
      this.cooldowns.delete(type);
    }
    return null;
  }

  getActiveCooldowns() {
    const now = Date.now();
    const cooldowns = [];
    for (const [type, until] of this.cooldowns.entries()) {
      if (now < until) {
        cooldowns.push({ type, remainingMs: until - now });
      } else {
        this.cooldowns.delete(type);
      }
    }
    return cooldowns.sort((left, right) => left.remainingMs - right.remainingMs);
  }

  isSiteBlocked(contextName, site) {
    const siteBlocks = this.siteBlockedContexts.get(contextName);
    if (!siteBlocks?.[site]) {
      return false;
    }

    if (this.hasSiteBlockExpired(siteBlocks[site])) {
      delete siteBlocks[site];
      if (Object.keys(siteBlocks).length === 0) {
        this.siteBlockedContexts.delete(contextName);
      }
      return false;
    }

    return true;
  }

  hasSiteBlockExpired(blockedAt) {
    return Date.now() - blockedAt > this.siteBlockExpirationPeriod;
  }
}

const browserPool = new BrowserPool();
export default browserPool;
