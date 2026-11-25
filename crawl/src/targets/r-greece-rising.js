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
const MIN_INITIAL_THREAD_COUNT = 4;
const MIN_READY_THREAD_COUNT = 20;
const INCOMPLETE_PAGE_RETRY_MS = 5_000;
const INCOMPLETE_PAGE_BROWSER_RESTART_ATTEMPTS = 3;

export const target = {
  name: "r-greece-rising",
  site: "reddit",
  preserveBrowserData: true,
  browserContextName: "reddit-browser",
  source: {
    slug: "reddit",
    displayName: "Reddit",
    baseUrl: "https://www.reddit.com",
  },
  topic: {
    slug: "r-greece-rising",
    displayName: "r/greece",
    rankingStrategy: "external",
    feedSize: 50,
  },
  listingUrl: "https://www.reddit.com/r/greece/rising/",
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
      `[crawl:${target.name}] keeping browser open and refreshing every ${config.redditRisingRefreshMinMs}-${config.redditRisingRefreshMaxMs}ms; press Ctrl+C to finish`,
    );

    let browserClosed = watchBrowserClosed(page);
    const restartBrowser = async (reason = "repeated incomplete page loads") => {
      console.warn(
        `[crawl:${target.name}] restarting browser after ${reason}`,
      );
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
          await restartBrowser(`fatal browser error: ${error.message}`);
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

        await restartBrowser(`wait ended by ${waitResult.type}`);
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

async function runCrawlPass(getPage, restartBrowser, pass, signal) {
  console.log(`[crawl:${target.name}] starting pass ${pass}`);

  const threads = await loadThreadsForCrawlPass(
    getPage,
    restartBrowser,
    signal,
  );
  const crawledAt = new Date().toISOString();

  console.log(
    `[crawl:${target.name}] extracted ${threads.length} thread(s) from ${target.listingUrl}`,
  );

  await enqueueCrawlPass({ target, crawledAt, items: threads });
  console.log(
    `[crawl:${target.name}] queued crawl ${crawledAt} with ${threads.length} item(s) for backend delivery`,
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
    count: delivery.error ? 0 : threads.length,
    items: threads,
  };
}

async function loadThreadsForCrawlPass(getPage, restartBrowser, signal) {
  let loadAttempt = 1;
  let page = getPage();

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
        const markedProxy = markBrowserProxyFailure(contextName, {
          severity: "high",
          proxyContext: target.site,
        });
        console.warn(
          `[crawl:${target.name}] listing request exhausted retries; ${
            markedProxy ? "blacklisted current proxy and restarting" : "restarting browser"
          }: ${error.message}`,
        );
        page = await restartBrowser(`proxy/network listing error: ${error.message}`);
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
      return await extractReadyThreads(page, signal);
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
  const min = config.redditRisingRefreshMinMs;
  const max = config.redditRisingRefreshMaxMs;
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

async function extractReadyThreads(page, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  console.log(
    `[crawl:${target.name}] waiting for feed to settle before extraction`,
  );
  await page.waitForSelector("shreddit-feed article", { timeout: 15_000 });
  await page.waitForTimeout(4_000);

  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const initialThreads = await extractThreads(page, signal);
  console.log(
    `[crawl:${target.name}] initial feed has ${initialThreads.length} valid thread(s)`,
  );

  console.log(
    `[crawl:${target.name}] scrolling once to trigger additional thread loading`,
  );
  await page.evaluate(() => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "instant",
    });
  });

  await page.waitForTimeout(4_000);

  const scrolledThreads = await extractThreads(page, signal);
  console.log(
    `[crawl:${target.name}] scrolled feed has ${scrolledThreads.length} valid thread(s)`,
  );

  const threads = mergeThreadBatches(initialThreads, scrolledThreads);
  console.log(
    `[crawl:${target.name}] merged feed has ${threads.length} unique thread(s)`,
  );

  if (threads.length < MIN_INITIAL_THREAD_COUNT) {
    throw new Error(
      `initial feed incomplete after scroll merge: found ${threads.length}, expected at least ${MIN_INITIAL_THREAD_COUNT}`,
    );
  }

  if (threads.length < MIN_READY_THREAD_COUNT) {
    throw new Error(
      `merged feed incomplete: found ${threads.length}, expected at least ${MIN_READY_THREAD_COUNT}`,
    );
  }

  if (
    threads.length <= initialThreads.length &&
    initialThreads.length < MIN_READY_THREAD_COUNT
  ) {
    throw new Error(
      `scroll did not load additional threads: initial=${initialThreads.length}, merged=${threads.length}`,
    );
  }

  return threads;
}

function mergeThreadBatches(...batches) {
  const threadsById = new Map();
  const threadIds = [];

  for (const batch of batches) {
    for (const thread of batch) {
      if (!threadsById.has(thread.externalId)) {
        threadIds.push(thread.externalId);
      }

      threadsById.set(thread.externalId, {
        ...threadsById.get(thread.externalId),
        ...thread,
      });
    }
  }

  return threadIds.map((externalId, index) => ({
    ...threadsById.get(externalId),
    rank: index + 1,
  }));
}

async function extractThreads(page, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const threads = await page.evaluate(() => {
    const parseNumber = (value) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }

      if (typeof value !== "string") {
        return null;
      }

      const normalized = value
        .trim()
        .toLowerCase()
        .replace(/,/g, "")
        .replace(/\s+/g, "");
      const match = normalized.match(/^(\d+(?:\.\d+)?)([kmb])?$/);

      if (!match) {
        return null;
      }

      const base = Number.parseFloat(match[1]);
      const multiplier =
        match[2] === "k"
          ? 1_000
          : match[2] === "m"
            ? 1_000_000
            : match[2] === "b"
              ? 1_000_000_000
              : 1;

      return Math.round(base * multiplier);
    };

    const readAttribute = (element, names) => {
      if (!element) {
        return null;
      }

      for (const name of names) {
        const value = element.getAttribute(name);
        if (typeof value === "string" && value.trim() !== "") {
          return value.trim();
        }
      }

      return null;
    };

    const getCanonicalUrl = (article, post) => {
      const link =
        article.querySelector('a[href*="/comments/"]') ||
        post?.querySelector('a[href*="/comments/"]');
      const rawUrl =
        link?.href ||
        readAttribute(post, [
          "permalink",
          "content-href",
          "post-permalink",
          "url",
        ]);

      if (!rawUrl) {
        return null;
      }

      const url = new URL(rawUrl, location.origin);
      url.search = "";
      url.hash = "";
      return `${url.origin}${decodeURIComponent(url.pathname)}`;
    };

    const getTitle = (article, post) =>
      readAttribute(post, ["post-title", "title"]) ||
      article.querySelector("h1, h2, h3")?.textContent?.trim() ||
      article.querySelector('a[href*="/comments/"]')?.textContent?.trim() ||
      null;

    const getPublishedAt = (article, post) =>
      article.querySelector("time[datetime]")?.dateTime ||
      readAttribute(post, [
        "created-timestamp",
        "created-time",
        "created-at",
        "timestamp",
      ]) ||
      null;

    const getScore = (article, post) => {
      const directScore = readAttribute(post, [
        "score",
        "vote-count",
        "score-value",
        "upvote-count",
      ]);
      const parsedDirectScore = parseNumber(directScore);
      if (parsedDirectScore !== null) {
        return parsedDirectScore;
      }

      const scoreNode = article.querySelector(
        '[score], [vote-count], [upvote-count], faceplate-number, [aria-label*="upvote"], [aria-label*="score"]',
      );
      const scoreText =
        readAttribute(scoreNode, ["score", "vote-count", "upvote-count"]) ||
        scoreNode?.textContent?.trim() ||
        null;

      return parseNumber(scoreText);
    };

    const getCommentsCount = (article, post) => {
      const directCount = readAttribute(post, [
        "comment-count",
        "comments-count",
        "commentCount",
      ]);
      const parsedDirectCount = parseNumber(directCount);
      if (parsedDirectCount !== null) {
        return parsedDirectCount;
      }

      const commentsButton = article.querySelector(
        'a[name="comments-action-button"], a[data-action-bar-action="comments"], a[data-post-click-location="comments-button"]',
      );
      const commentsNumber = commentsButton?.querySelector("faceplate-number");
      const buttonCount = readAttribute(commentsNumber, ["number"]);
      const parsedButtonCount = parseNumber(buttonCount);
      if (parsedButtonCount !== null) {
        return parsedButtonCount;
      }

      return parseNumber(
        commentsNumber?.textContent?.trim() ||
          commentsButton?.textContent?.trim(),
      );
    };

    const getIsNsfw = (article, post) => {
      if (post?.hasAttribute("nsfw")) {
        return true;
      }

      if (article.querySelector("shreddit-content-tags [text='NSFW']")) {
        return true;
      }

      if (
        article
          .querySelector("shreddit-content-tags")
          ?.textContent?.toUpperCase()
          .includes("NSFW")
      ) {
        return true;
      }

      return article
        .querySelector("shreddit-post-overflow-menu")
        ?.hasAttribute("is-post-nsfw");
    };

    const toIsoTimestamp = (value) => {
      if (!value) {
        return null;
      }

      const timestamp = new Date(value);
      if (Number.isNaN(timestamp.getTime())) {
        return null;
      }

      return timestamp.toISOString();
    };

    return [...document.querySelectorAll("shreddit-feed article")]
      .map((article, index) => {
        const post = article.querySelector("shreddit-post");
        const url = getCanonicalUrl(article, post);
        const rawId =
          url?.match(/\/comments\/([^/]+)/)?.[1] ||
          readAttribute(post, ["post-id", "id"])?.replace(/^t3_/, "") ||
          null;
        const title = getTitle(article, post);
        const publishedAt = toIsoTimestamp(getPublishedAt(article, post));
        const score = getScore(article, post);
        const commentsCount = getCommentsCount(article, post);
        const nsfw = getIsNsfw(article, post);

        if (!rawId || !title || !url || !publishedAt || score === null) {
          return null;
        }

        return {
          externalId: `t3_${rawId}`,
          title,
          url,
          score,
          commentsCount,
          nsfw,
          publishedAt,
          rank: index + 1,
        };
      })
      .filter(Boolean);
  });

  if (!threads.length) {
    throw new Error("No Reddit rising threads found on the page");
  }

  return threads;
}
