import fs from "node:fs/promises";
import path from "node:path";

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
const MIN_READY_TOPIC_COUNT = config.myphoneTopicsMinReadyCount;
const MAX_LOAD_MORE_CLICKS = config.myphoneTopicsMaxLoadMoreClicks;
const INCOMPLETE_PAGE_RETRY_MS = 5_000;
const INCOMPLETE_PAGE_BROWSER_RESTART_ATTEMPTS = 3;
const MYPHONE_TOPICS_STREAM_URL = "https://myphone.gr/forum/discover/";
const ACTIVITY_HISTORY_PATH = path.resolve(
  config.backendOutboxRoot,
  "..",
  "myphone-topics-activity-history.json",
);
const RECENT_REPLY_WINDOW_HOURS = 24;
const MIN_ACTIVITY_INTERVAL_HOURS = 5 / 60;
const MAX_RECENT_REPLY_MULTIPLIER = 48;

export const target = {
  name: "myphone-topics",
  site: "myphone",
  preserveBrowserData: true,
  browserContextName: "myphone-browser",
  source: {
    slug: "myphone",
    displayName: "myphone",
    baseUrl: "https://myphone.gr",
  },
  topic: {
    slug: "myphone-topics",
    displayName: "myphone",
    rankingStrategy: "hot",
    feedSize: 50,
    hotGravity: 1.8,
  },
  listingUrl: MYPHONE_TOPICS_STREAM_URL,
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
      `[crawl:${target.name}] keeping browser open and refreshing every ${config.myphoneTopicsRefreshMinMs}-${config.myphoneTopicsRefreshMaxMs}ms; press Ctrl+C to finish`,
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

  const extractedTopics = await loadTopicsForCrawlPass(
    getPage,
    restartBrowser,
    signal,
  );
  const crawledAt = new Date().toISOString();
  const topics = await applyRecentActivityScores(extractedTopics, crawledAt);

  console.log(
    `[crawl:${target.name}] extracted ${topics.length} topic(s) from ${target.listingUrl}`,
  );

  await enqueueCrawlPass({ target, crawledAt, items: topics });
  console.log(
    `[crawl:${target.name}] queued crawl ${crawledAt} with ${topics.length} item(s) for backend delivery`,
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
  } else {
    await backendClient.rerankTopic(target.topic.slug);
    console.log(`[crawl:${target.name}] queued hot rerank for ${target.topic.slug}`);
  }

  return {
    count: delivery.error ? 0 : topics.length,
    items: topics,
  };
}

async function applyRecentActivityScores(topics, crawledAt) {
  const history = await readActivityHistory();
  const nextHistory = { ...history };
  const observedAtMs = Date.parse(crawledAt);

  const scoredTopics = topics.map((topic) => {
    const previous = history[topic.externalId] || null;
    const previousObservedAtMs = Date.parse(previous?.observedAt || "");
    const previousCommentsCount = Number.isInteger(previous?.commentsCount)
      ? previous.commentsCount
      : null;
    const recentRepliesCount =
      previousCommentsCount === null
        ? 0
        : Math.max(0, topic.commentsCount - previousCommentsCount);
    const observedIntervalHours =
      Number.isFinite(observedAtMs) &&
      Number.isFinite(previousObservedAtMs) &&
      observedAtMs > previousObservedAtMs
        ? (observedAtMs - previousObservedAtMs) / 3_600_000
        : null;
    const recentReplyBoost = calculateRecentReplyBoost(
      recentRepliesCount,
      observedIntervalHours,
    );

    nextHistory[topic.externalId] = {
      commentsCount: topic.commentsCount,
      observedAt: crawledAt,
    };

    return {
      ...topic,
      score: topic.commentsCount + 1 + recentReplyBoost,
      recentRepliesCount,
      recentReplyBoost,
      observedIntervalHours:
        observedIntervalHours === null
          ? null
          : Math.round(observedIntervalHours * 1_000) / 1_000,
    };
  });

  await writeActivityHistory(nextHistory);
  return scoredTopics;
}

function calculateRecentReplyBoost(recentRepliesCount, observedIntervalHours) {
  if (!recentRepliesCount || !observedIntervalHours) {
    return 0;
  }

  const intervalHours = Math.max(observedIntervalHours, MIN_ACTIVITY_INTERVAL_HOURS);
  const multiplier = Math.min(
    MAX_RECENT_REPLY_MULTIPLIER,
    Math.max(1, RECENT_REPLY_WINDOW_HOURS / intervalHours),
  );

  return Math.round(recentRepliesCount * multiplier);
}

async function readActivityHistory() {
  try {
    return JSON.parse(await fs.readFile(ACTIVITY_HISTORY_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeActivityHistory(history) {
  await fs.mkdir(path.dirname(ACTIVITY_HISTORY_PATH), { recursive: true });
  const temporaryPath = `${ACTIVITY_HISTORY_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(history)}\n`, "utf8");
  await fs.rename(temporaryPath, ACTIVITY_HISTORY_PATH);
}

async function loadTopicsForCrawlPass(getPage, restartBrowser, signal) {
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
      return await extractReadyTopics(page, signal);
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

async function extractReadyTopics(page, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  console.log(
    `[crawl:${target.name}] waiting for MyPhone activity stream to settle before extraction`,
  );
  await page.waitForSelector('li[data-role="activityItem"]', { timeout: 15_000 });
  await page.waitForTimeout(2_000);

  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  let activityItemCount = await getActivityItemCount(page);
  const initialTopics = await extractTopics(page, signal);
  console.log(
    `[crawl:${target.name}] initial stream has ${initialTopics.length} valid topic(s)`,
  );

  const batches = [initialTopics];
  let topics = mergeTopicBatches(...batches);

  for (
    let loadMoreClick = 1;
    topics.length < MIN_READY_TOPIC_COUNT &&
    loadMoreClick <= MAX_LOAD_MORE_CLICKS;
    loadMoreClick += 1
  ) {
    const loadMoreResult = await clickMoreActivity(
      page,
      activityItemCount,
      loadMoreClick,
      signal,
    );

    activityItemCount = loadMoreResult.activityItemCount;
    if (!loadMoreResult.loaded) {
      break;
    }

    const expandedTopics = await extractTopics(page, signal);
    batches.push(expandedTopics);
    topics = mergeTopicBatches(...batches);

    console.log(
      `[crawl:${target.name}] expanded activity feed after load-more ${loadMoreClick} has ${expandedTopics.length} valid topic(s), ${topics.length} unique topic(s)`,
    );
  }

  console.log(
    `[crawl:${target.name}] merged stream has ${topics.length} unique topic(s)`,
  );

  if (topics.length < MIN_READY_TOPIC_COUNT) {
    console.log(
      `[crawl:${target.name}] accepting ${topics.length} unique topic(s); no more load-more rows were available before reaching ${MIN_READY_TOPIC_COUNT}`,
    );
  }

  return topics;
}

async function getActivityItemCount(page) {
  return page.evaluate(
    () => document.querySelectorAll('li[data-role="activityItem"]').length,
  );
}

async function clickMoreActivity(page, previousActivityItemCount, clickNumber, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const clicked = await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('a[href], button, [role="button"]'),
    ];
    const loadMore = candidates.find((element) => {
      const text = element.textContent?.replace(/\s+/g, " ").trim() || "";
      const href = element.getAttribute("href") || "";
      const ariaLabel = element.getAttribute("aria-label") || "";

      return (
        text.includes("Φόρτωση περισσότερων") ||
        ariaLabel.includes("Φόρτωση περισσότερων") ||
        href.includes("changeTime=")
      );
    });

    if (!(loadMore instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(loadMore);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    loadMore.click();
    return true;
  });

  if (!clicked) {
    console.log(`[crawl:${target.name}] no load-more activity control found`);
    return {
      loaded: false,
      activityItemCount: await getActivityItemCount(page),
    };
  }

  console.log(`[crawl:${target.name}] clicked load-more activity control ${clickNumber}`);

  await page
    .waitForFunction(
      (count) =>
        document.querySelectorAll('li[data-role="activityItem"]').length > count,
      previousActivityItemCount,
      { timeout: 10_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1_000);

  const activityItemCount = await getActivityItemCount(page);
  if (activityItemCount <= previousActivityItemCount) {
    console.log(
      `[crawl:${target.name}] load-more click ${clickNumber} did not add new activity rows`,
    );
    return { loaded: false, activityItemCount };
  }

  return { loaded: true, activityItemCount };
}

function mergeTopicBatches(...batches) {
  const topicsById = new Map();
  const topicIds = [];

  for (const batch of batches) {
    for (const topic of batch) {
      if (!topicsById.has(topic.externalId)) {
        topicIds.push(topic.externalId);
      }

      topicsById.set(topic.externalId, {
        ...topicsById.get(topic.externalId),
        ...topic,
      });
    }
  }

  return topicIds.map((externalId, index) => ({
    ...topicsById.get(externalId),
    rank: index + 1,
  }));
}

async function extractTopics(page, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const topics = await page.evaluate(extractMyPhoneTopicsFromDocument);

  if (!topics.length) {
    throw new Error("No MyPhone topics found on the page");
  }

  return topics;
}

export function extractMyPhoneTopicsFromDocument() {
  const parseInteger = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }

    if (typeof value !== "string") {
      return null;
    }

    const match = value.trim().match(/(\d[\d.,]*)/);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[1].replace(/[.,]/g, ""), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  };

  const toActivityTimestamp = (streamItem) => {
    const unixTimestamp = parseInteger(streamItem.dataset.timestamp);
    if (unixTimestamp !== null) {
      return {
        iso: new Date(unixTimestamp * 1_000).toISOString(),
        unix: unixTimestamp,
      };
    }

    const datetime = streamItem
      .querySelector("time[datetime]")
      ?.getAttribute("datetime");
    if (!datetime) {
      return null;
    }

    const timestamp = new Date(datetime);
    if (Number.isNaN(timestamp.getTime())) {
      return null;
    }

    return {
      iso: timestamp.toISOString(),
      unix: Math.floor(timestamp.getTime() / 1_000),
    };
  };

  const canonicalizeUrl = (rawUrl) => {
    if (!rawUrl) {
      return null;
    }

    const url = new URL(rawUrl, location.origin);
    url.search = "";
    url.hash = "";
    return `${url.origin}${decodeURIComponent(url.pathname)}`;
  };

  const getCommentsCount = (streamItem) => {
    const replyText = streamItem.querySelectorAll(".ipsStreamItem_meta li")[1]
      ?.textContent;

    return parseInteger(replyText || "") ?? 0;
  };

  const getText = (element) => element?.textContent?.trim() || null;

  return [...document.querySelectorAll('li[data-role="activityItem"]')]
    .map((streamItem, index) => {
      const link = streamItem.querySelector(".ipsStreamItem_title a");
      const url = canonicalizeUrl(link?.href || link?.getAttribute("href"));
      const rawId = link?.href?.match(/\/topic\/(\d+)/)?.[1] || null;
      const commentId = link?.href?.match(/[?&]comment=(\d+)/)?.[1] || null;
      const title = getText(link);
      const activityTimestamp = toActivityTimestamp(streamItem);
      const commentsCount = getCommentsCount(streamItem);
      const profileLinks = streamItem.querySelectorAll(
        '.ipsStreamItem_status a[href*="/profile/"]',
      );
      const actorEl = profileLinks[0] || null;
      const opEl = profileLinks[1] || null;
      const forumEl = streamItem.querySelector(
        '.ipsStreamItem_status a[href*="/forum/forum/"]',
      );
      const snippet = getText(streamItem.querySelector("[data-ipstruncate]"));
      const reactionCount =
        parseInteger(
          streamItem.querySelector(".ipsReactOverview_repCount")?.textContent,
        ) ?? 0;
      const reactionType =
        streamItem.querySelector(".ipsReactOverview img")?.getAttribute("alt") ||
        null;
      const contentType =
        streamItem
          .querySelector(".ipsStreamItem_contentType")
          ?.getAttribute("title") || null;

      if (!rawId || !title || !url || !activityTimestamp) {
        return null;
      }

      return {
        externalId: `topic_${rawId}`,
        title,
        url,
        score: commentsCount + 1,
        commentsCount,
        publishedAt: activityTimestamp.iso,
        rank: index + 1,
        metadata: {
          last_activity_at: activityTimestamp.iso,
          activity_timestamp: activityTimestamp.unix,
          comment_id: commentId,
          actor: getText(actorEl),
          actor_url: actorEl?.href || null,
          original_poster: getText(opEl),
          original_poster_url: opEl?.href || null,
          forum: getText(forumEl),
          forum_url: forumEl?.href || null,
          snippet,
          reaction_count: reactionCount,
          reaction_type: reactionType,
          content_type: contentType,
        },
      };
    })
    .filter(Boolean);
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
  const min = config.myphoneTopicsRefreshMinMs;
  const max = config.myphoneTopicsRefreshMaxMs;
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
