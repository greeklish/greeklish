import crypto from "node:crypto";

import { BackendClient } from "../lib/backend-client.js";
import {
  enqueueCrawlPass,
  flushCrawlPassOutbox,
} from "../lib/backend-outbox.js";
import {
  closeBrowser,
  initBrowser,
  markBrowserProxyFailure,
  watchPageUnavailable,
} from "../lib/browser.js";
import { loadConfig } from "../lib/config.js";
import { withRetries } from "../lib/retry.js";

const config = loadConfig();
const backendClient = new BackendClient();
const MIN_READY_TREND_COUNT = config.xTrendsMinReadyCount;
const INCOMPLETE_PAGE_RETRY_MS = 5_000;
const INCOMPLETE_PAGE_BROWSER_RESTART_ATTEMPTS = 3;
const X_TRENDS_URL = "https://x.com/explore/tabs/trending";

export const target = {
  name: "x-trends",
  site: "x",
  preserveBrowserData: true,
  browserContextName: "x-browser",
  source: {
    slug: "x",
    displayName: "twitter/x",
    baseUrl: "https://x.com",
  },
  topic: {
    slug: "x-trends",
    displayName: "twitter/x",
    rankingStrategy: "external",
    feedSize: 50,
  },
  listingUrl: X_TRENDS_URL,
};

export async function runTarget({ signal } = {}) {
  const contextName = target.browserContextName;
  let page = await openCrawlerBrowser(contextName);

  try {
    await ensureBackendMetadata().catch((error) => {
      console.error(
        `[crawl:${target.name}] backend metadata unavailable; crawls will be queued: ${error.message}`,
      );
    });

    console.log(
      `[crawl:${target.name}] keeping browser open and refreshing every ${config.xTrendsRefreshMinMs}-${config.xTrendsRefreshMaxMs}ms; press Ctrl+C to finish`,
    );

    let browserClosed = watchBrowserClosed(page);
    const restartBrowser = async (reason = "repeated incomplete page loads") => {
      console.warn(`[crawl:${target.name}] restarting browser after ${reason}`);
      await closeBrowser(contextName).catch(() => {});
      page = await openCrawlerBrowser(contextName);
      browserClosed = watchBrowserClosed(page);
      return page;
    };
    let latestResult = { count: 0, items: [] };
    let pass = 1;

    for (;;) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (page.isClosed()) {
        await restartBrowser("browser closed before next pass");
      }

      try {
        latestResult = await runCrawlPass(
          () => page,
          restartBrowser,
          pass,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }

        console.error(
          `[crawl:${target.name}] pass ${pass} failed: ${error.message}`,
        );

        if (isFatalBrowserError(error)) {
          page = await restartBrowser(`fatal browser error: ${error.message}`);
        }
      }

      const delayMs = randomRefreshDelayMs();
      console.log(
        `[crawl:${target.name}] waiting ${formatDuration(delayMs)} before next pass`,
      );

      const waitResult = await waitForNextPass(signal, browserClosed, delayMs);

      if (waitResult.type !== "timer") {
        console.log(
          `[crawl:${target.name}] finished waiting: ${JSON.stringify(waitResult)}`,
        );
        if (waitResult.type === "signal-aborted") {
          break;
        }

        page = await restartBrowser(`wait ended by ${waitResult.type}`);
      }

      pass += 1;
    }

    return latestResult;
  } finally {
    await closeBrowser(contextName).catch(() => {});
  }
}

async function openCrawlerBrowser(contextName) {
  return initBrowser(contextName, {
    withProxy: config.useBrowserProxies,
    debugMode: config.debugMode,
    configureForScraping: true,
    proxyContext: target.site,
    userDataDir: contextName,
    quiet: false,
  });
}

function watchBrowserClosed(page) {
  return watchPageUnavailable(page);
}

async function isLoginRequired(page) {
 return page.evaluate(() => {
    const loginPlaceholder = [
      ...document.querySelectorAll("span.jf-element.jf-float-label-placholder"),
    ].some((element) => element.textContent?.trim() === "Email or username");
    const usernameInput = document.querySelector(
      'input[autocomplete="username"], input[name="text"]',
    );

    if (loginPlaceholder || usernameInput) {
      return true;
    }

    return ["/i/flow/login", "/login"].some((path) =>
      location.pathname.startsWith(path),
    );
  });
}

async function hasTrendRows(page) {
  return page.evaluate(() => Boolean(document.querySelector('[data-testid="trend"]')));
}

async function waitForTrendsOrManualLogin(page, signal) {
  let loginLogged = false;
  let lastLogAt = Date.now();

  for (;;) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (page.isClosed()) {
      throw new Error("Page has been closed");
    }

    if (await hasTrendRows(page)) {
      if (loginLogged) {
        console.log(`[crawl:${target.name}] X trends are visible after manual login`);
      }
      return;
    }

    if (await hasTransientReloadError(page)) {
      console.warn(
        `[crawl:${target.name}] X transient reload error visible; reloading page`,
      );
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.waitForTimeout(3_000);
      continue;
    }

    const loginRequired = await isLoginRequired(page);
    if (loginRequired && !loginLogged) {
      console.log(
        `[crawl:${target.name}] X login required; use the opened browser window to sign in manually`,
      );
      loginLogged = true;
    }

    if (Date.now() - lastLogAt > 30_000) {
      console.log(
        loginLogged
          ? `[crawl:${target.name}] still waiting for manual X login`
          : `[crawl:${target.name}] still waiting for X trends or login screen`,
      );
      lastLogAt = Date.now();
    }

    await page.waitForTimeout(1_000);
  }
}

async function hasTransientReloadError(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll("span, div")].some(
      (element) =>
        normalize(element.textContent) === "Something went wrong. Try reloading.",
    );
  });
}

async function runCrawlPass(getPage, restartBrowser, pass, signal) {
  console.log(`[crawl:${target.name}] starting pass ${pass}`);

  const crawledAt = new Date().toISOString();
  const page = getPage();
  const trends = await loadTrendsForCrawlPass(page, restartBrowser, crawledAt, signal);

  console.log(
    `[crawl:${target.name}] extracted ${trends.length} trend(s) from ${target.listingUrl}`,
  );

  await enqueueCrawlPass({ target, crawledAt, items: trends });
  console.log(
    `[crawl:${target.name}] queued crawl ${crawledAt} with ${trends.length} item(s) for backend delivery`,
  );

  const delivery = await flushCrawlPassOutbox({
    backendClient,
    signal,
    logger: (message) => console.log(`[crawl:${target.name}] ${message}`),
  });

  if (delivery.error) {
    console.error(
      `[crawl:${target.name}] backend delivery paused with ${delivery.pendingPasses} queued crawl(s): ${delivery.error.message}`,
    );
  }

  return {
    count: delivery.error ? 0 : trends.length,
    items: trends,
  };
}

async function loadTrendsForCrawlPass(page, restartBrowser, crawledAt, signal) {
  let loadAttempt = 1;

  for (;;) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (page.isClosed()) {
      throw new Error("Page has been closed");
    }

    let response;
    try {
      response = await withRetries(
        async () =>
          page.goto(target.listingUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }),
        {
          maxRetries: 3,
          onRetry: ({ attempt, error, waitMs }) => {
            console.warn(
              `[crawl:${target.name}] listing request failed on attempt ${attempt}: ${error.message}; retrying in ${waitMs}ms`,
            );
          },
        },
      );
    } catch (error) {
      if (isProxyConnectionError(error)) {
        const markedProxy = markBrowserProxyFailure(target.browserContextName, {
          severity: "high",
          proxyContext: target.site,
        });
        console.warn(
          `[crawl:${target.name}] listing request exhausted retries; ${
            markedProxy ? "blacklisted current proxy and restarting" : "restarting browser"
          }: ${error.message}`,
        );
        page = await restartBrowser(
          `proxy/network listing error: ${error.message}`,
        );
        loadAttempt = 1;
        continue;
      }

      throw error;
    }

    console.log(
      `[crawl:${target.name}] opened ${target.listingUrl} in browser-data/${target.browserContextName}`,
    );
    console.log(
      `[crawl:${target.name}] response status ${response?.status() ?? "unknown"}`,
    );

    try {
      await waitForTrendsOrManualLogin(page, signal);
      return await extractReadyTrends(page, crawledAt, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

      console.warn(
        `[crawl:${target.name}] page load attempt ${loadAttempt} incomplete: ${error.message}; refreshing in ${formatDuration(INCOMPLETE_PAGE_RETRY_MS)}`,
      );
      loadAttempt += 1;
      if ((loadAttempt - 1) % INCOMPLETE_PAGE_BROWSER_RESTART_ATTEMPTS === 0) {
        page = await restartBrowser("repeated incomplete page loads");
      } else {
        await page.waitForTimeout(INCOMPLETE_PAGE_RETRY_MS);
      }
    }
  }
}

async function extractReadyTrends(page, crawledAt, signal) {
  console.log(`[crawl:${target.name}] waiting for X trends to settle before extraction`);
  await page.waitForSelector('[data-testid="trend"]', { timeout: 20_000 });
  await page.waitForTimeout(2_000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(500);

  const seen = new Map();
  let previousCount = 0;
  let stablePasses = 0;

  for (let scrollPass = 0; scrollPass < config.xTrendsMaxScrolls; scrollPass += 1) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    const visibleTrends = await page.evaluate(extractVisibleTrendsFromDocument);
    for (const trend of visibleTrends) {
      seen.set(trend.rank, trend);
    }

    if (seen.size === previousCount) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
      previousCount = seen.size;
    }

    if (seen.size >= MIN_READY_TREND_COUNT && stablePasses >= 1) {
      break;
    }

    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(350);
  }

  const loadedTrends = [...seen.values()].sort((left, right) => left.rank - right.rank);

  if (loadedTrends.length < MIN_READY_TREND_COUNT) {
    throw new Error(
      `X trends incomplete: found ${loadedTrends.length}, expected at least ${MIN_READY_TREND_COUNT}`,
    );
  }

  const trends = buildTrendItems(loadedTrends, crawledAt);

  console.log(
    `[crawl:${target.name}] keeping ${trends.length} Trending in Greece trend(s) from ${loadedTrends.length} loaded trend(s)`,
  );

  return trends;
}

export function extractVisibleTrendsFromDocument() {
  const parseRank = (value) => {
    const match = String(value || "").match(/\d+/);
    return match ? Number.parseInt(match[0], 10) : null;
  };

  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isPostsText = (text) =>
    /^[\d.,]+\s*(?:[KMB]|χιλ\.?|εκ\.?)?\s+(?:posts?|tweets?|αναρτήσεις)$/iu.test(text);
  const isContextText = (text) =>
    /^(?:\d+\s*[·.]\s*)?(?:.*\s[·•]\s*)?trending(?:\s+(?:in|with)\b.*)?$/i.test(text) ||
    /^(?:τάση|τάσεις)(?:\s+(?:στην|στο|σε)\s.*)?$/i.test(text);
  const directionSelector = '[dir="ltr"], [dir="auto"], [dir="rtl"]';

  const readLabel = (element) => {
    // X puts the primary name before its "Trending with" links. Layout classes are
    // shared by both groups, so neither a flex class nor the last text node is a title.
    const candidates = [...element.querySelectorAll(directionSelector)];
    for (const candidate of candidates) {
      if (candidate.querySelector(directionSelector)) continue;
      if (candidate.closest('button, [role="button"]')) continue;
      const label = normalize(candidate.textContent);
      if (!label || /^[\s\p{P}]+$/u.test(label) || /^\d+$/.test(label) || isContextText(label) || isPostsText(label)) {
        continue;
      }
      let related = false;
      for (let parent = candidate.parentElement; parent && parent !== element; parent = parent.parentElement) {
        if (/^trending\s+with\b/i.test(normalize(parent.textContent))) {
          related = true;
          break;
        }
      }
      if (!related) return label;
    }
    return null;
  };

  const readContext = (element, label) => {
    const values = [...element.querySelectorAll("span, div")]
      .map((candidate) => candidate.textContent?.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((text, index, list) => list.indexOf(text) === index)
      .filter((text) => text !== label)
      .filter((text) => !/^\d+$/.test(text));

    const trendContextValues = values.filter((text) => /trending|τάση/i.test(text));

    return (
      trendContextValues.find((text) => /^trending in greece$/i.test(text)) ||
      trendContextValues.find((text) => /\btrending in greece\b/i.test(text)) ||
      trendContextValues[0] ||
      null
    );
  };

  const readPostsText = (element) =>
    [...element.querySelectorAll("span, div")]
      .map((candidate) => candidate.textContent?.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .find(isPostsText) || null;

  return [...document.querySelectorAll('[data-testid="trend"]')]
    .map((element) => {
      const rank = parseRank(
        element.querySelector('[aria-hidden="true"]')?.textContent,
      );
      const label = readLabel(element);

      if (!rank || !label) {
        return null;
      }

      return {
        rank,
        label,
        context: readContext(element, label),
        postsText: readPostsText(element),
      };
    })
    .filter(Boolean);
}

function isTrendingInGreeceTrend(trend) {
  const context = normalizeTrendText(trend.context);

  return /^trending in greece$/i.test(context) || /\btrending in greece\b/i.test(context);
}

function normalizeTrendText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function buildTrendItems(trends, crawledAt) {
  const seen = new Set();
  return trends.filter(isTrendingInGreeceTrend).map((trend) => buildTrendItem(trend, crawledAt)).filter((item) => {
    if (seen.has(item.externalId)) return false;
    seen.add(item.externalId);
    return true;
  });
}

function buildTrendItem(trend, crawledAt) {
  const searchUrl = new URL("https://x.com/search");
  searchUrl.searchParams.set("q", trend.label);
  searchUrl.searchParams.set("src", "trend_click");

  return {
    externalId: `trend_${hashTrendLabel(trend.label)}`,
    title: trend.label,
    url: searchUrl.toString(),
    score: 0,
    publishedAt: crawledAt,
    rank: trend.rank,
    metadata: {
      trend_rank: trend.rank,
      context: trend.context,
      posts_text: trend.postsText,
      crawled_at: crawledAt,
    },
  };
}

function hashTrendLabel(label) {
  return crypto
    .createHash("sha1")
    .update(label.trim().toLocaleLowerCase("el-GR"))
    .digest("hex")
    .slice(0, 16);
}

function isFatalBrowserError(error) {
  const message = error?.message || "";

  return /ERR_ABORTED|Page crashed|Target closed|Page has been closed|Browser closed|browser.*disconnected|crash|no longer accessible/i.test(
    message,
  );
}

function isProxyConnectionError(error) {
  const message = error?.message || "";

  return /ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|NO_CONNECTIVITY|No internet connectivity/i.test(
    message,
  );
}

async function ensureBackendMetadata() {
  console.log(`[crawl:${target.name}] upserting source ${target.source.slug}`);
  await backendClient.upsertSource(target.source);

  console.log(`[crawl:${target.name}] upserting topic ${target.topic.slug}`);
  await backendClient.upsertTopic(target.topic);
}

function waitForNextPass(signal, browserClosed, intervalMs) {
  return new Promise((resolve) => {
    let isSettled = false;
    const timeoutId = setTimeout(() => finish({ type: "timer" }), intervalMs);
    const onAbort = () => finish({ type: "signal-aborted" });

    const finish = (result) => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    if (signal?.aborted) {
      finish({ type: "signal-aborted" });
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    browserClosed.then(finish, (error) =>
      finish({
        type: "context-close-error",
        error: error.message,
      }),
    );
  });
}

function randomRefreshDelayMs() {
  const min = config.xTrendsRefreshMinMs;
  const max = config.xTrendsRefreshMaxMs;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
