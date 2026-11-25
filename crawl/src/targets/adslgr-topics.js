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
const MIN_READY_TOPIC_COUNT = config.adslgrTopicsMinReadyCount;
const MAX_LOAD_MORE_CLICKS = config.adslgrTopicsMaxLoadMoreClicks;
const INCOMPLETE_PAGE_RETRY_MS = 5_000;
const INCOMPLETE_PAGE_BROWSER_RESTART_ATTEMPTS = 3;
const ADSLGR_ACTIVITY_URL = "https://www.adslgr.com/forum/activity.php";
const ACTIVITY_HISTORY_PATH = path.resolve(
  config.backendOutboxRoot,
  "..",
  "adslgr-topics-activity-history.json",
);
const RECENT_REPLY_WINDOW_HOURS = 24;
const MIN_ACTIVITY_INTERVAL_HOURS = 5 / 60;
const MAX_RECENT_REPLY_MULTIPLIER = 48;

export const target = {
  name: "adslgr-topics",
  site: "adslgr",
  preserveBrowserData: true,
  browserContextName: "adslgr-browser",
  source: {
    slug: "adslgr",
    displayName: "adslgr",
    baseUrl: "https://www.adslgr.com",
  },
  topic: {
    slug: "adslgr-topics",
    displayName: "adslgr",
    rankingStrategy: "hot",
    feedSize: 50,
    hotGravity: 1.8,
  },
  listingUrl: ADSLGR_ACTIVITY_URL,
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
      `[crawl:${target.name}] keeping browser open and refreshing every ${config.adslgrTopicsRefreshMinMs}-${config.adslgrTopicsRefreshMaxMs}ms; press Ctrl+C to finish`,
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

  const { topics: extractedTopics, crawledAt } = await loadTopicsForCrawlPass(
    getPage,
    restartBrowser,
    signal,
  );
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

    const crawledAt = getCrawledAt(response);
    const crawlEpochSeconds = Math.floor(Date.parse(crawledAt) / 1_000);

    try {
      const topics = await extractReadyTopics(page, crawlEpochSeconds, signal);
      return { topics, crawledAt };
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

function getCrawledAt(response) {
  const dateHeader = response?.headers()?.date;
  const dateHeaderTimestamp = Date.parse(dateHeader || "");

  if (Number.isFinite(dateHeaderTimestamp)) {
    return new Date(dateHeaderTimestamp).toISOString();
  }

  return new Date().toISOString();
}

async function extractReadyTopics(page, crawlEpochSeconds, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  console.log(
    `[crawl:${target.name}] waiting for vBulletin activity feed before extraction`,
  );
  await page.waitForSelector("li.activitybit.forum_post", {
    timeout: 15_000,
  });
  await page.waitForTimeout(1_000);

  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  let activityItemCount = await getActivityItemCount(page);
  const initialTopics = await extractTopics(page, crawlEpochSeconds, signal);
  console.log(
    `[crawl:${target.name}] initial activity feed has ${initialTopics.length} valid topic(s)`,
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

    const expandedTopics = await extractTopics(page, crawlEpochSeconds, signal);
    batches.push(expandedTopics);
    topics = mergeTopicBatches(...batches);

    console.log(
      `[crawl:${target.name}] expanded activity feed after load-more ${loadMoreClick} has ${expandedTopics.length} valid topic(s), ${topics.length} unique topic(s)`,
    );
  }

  console.log(
    `[crawl:${target.name}] merged activity feed has ${topics.length} unique topic(s)`,
  );

  if (topics.length < MIN_READY_TOPIC_COUNT) {
    throw new Error(
      `adslgr activity feed incomplete: found ${topics.length}, expected at least ${MIN_READY_TOPIC_COUNT}`,
    );
  }

  return topics;
}

async function getActivityItemCount(page) {
  return page.evaluate(
    () => document.querySelectorAll("li.activitybit.forum_post").length,
  );
}

async function clickMoreActivity(page, previousTopicCount, clickNumber, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const clicked = await page.evaluate(() => {
    const link = document.querySelector("a#moreactivitylink");
    if (!link) {
      return false;
    }

    const style = window.getComputedStyle(link);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    link.click();
    return true;
  });

  if (!clicked) {
    console.log(`[crawl:${target.name}] no more-activity link found`);
    return {
      loaded: false,
      activityItemCount: await getActivityItemCount(page),
    };
  }

  console.log(`[crawl:${target.name}] clicked more-activity link ${clickNumber}`);

  await page
    .waitForFunction(
      (count) =>
        document.querySelectorAll("li.activitybit.forum_post").length > count,
      previousTopicCount,
      { timeout: 8_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1_000);

  const activityItemCount = await getActivityItemCount(page);
  if (activityItemCount <= previousTopicCount) {
    console.log(
      `[crawl:${target.name}] more-activity click ${clickNumber} did not add new activity rows`,
    );
    return { loaded: false, activityItemCount };
  }

  return { loaded: true, activityItemCount };
}

function mergeTopicBatches(...batches) {
  const topicsById = new Map();

  for (const batch of batches) {
    for (const topic of batch) {
      if (!topicsById.has(topic.externalId)) {
        topicsById.set(topic.externalId, topic);
      }
    }
  }

  return Array.from(topicsById.values()).map((topic, index) => ({
    ...topic,
    rank: index + 1,
  }));
}

async function extractTopics(page, crawlEpochSeconds, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const topics = await page.evaluate(
    extractAdslgrTopicsFromDocument,
    crawlEpochSeconds,
  );

  if (!topics.length) {
    throw new Error("No adslgr forum posts found on the page");
  }

  return topics;
}

export function extractAdslgrTopicsFromDocument(crawlEpochSeconds) {
  const TIME_ZONE = "Europe/Athens";

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

  const canonicalizeUrl = (rawUrl, { keepPostPointer = false } = {}) => {
    if (!rawUrl) {
      return null;
    }

    const url = new URL(rawUrl, location.href);
    url.searchParams.delete("s");
    if (!keepPostPointer) {
      url.search = "";
      url.hash = "";
    }

    return `${url.origin}${decodeURIComponent(url.pathname)}${url.search}${url.hash}`;
  };

  const getAthensParts = (epochSeconds) => {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(epochSeconds * 1_000))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number.parseInt(part.value, 10)]),
    );

    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    };
  };

  const zonedDateTimeToEpochSeconds = ({
    year,
    month,
    day,
    hour,
    minute,
    second = 0,
  }) => {
    const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    let utcMs = targetAsUtcMs;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = getAthensParts(Math.floor(utcMs / 1_000));
      const actualAsUtcMs = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      const deltaMs = targetAsUtcMs - actualAsUtcMs;
      utcMs += deltaMs;

      if (deltaMs === 0) {
        break;
      }
    }

    return Math.floor(utcMs / 1_000);
  };

  const twoDigitYear = (value) => 2000 + value;

  const chooseClosestEpoch = (candidates) => {
    const validCandidates = candidates.filter((epoch) => Number.isInteger(epoch));
    if (!validCandidates.length) {
      return null;
    }

    return validCandidates.sort(
      (left, right) =>
        Math.abs(left - crawlEpochSeconds) - Math.abs(right - crawlEpochSeconds),
    )[0];
  };

  const parseActivityEpoch = (rawDate, rawTime) => {
    const dateMatch = rawDate
      ?.trim()
      .replace(/,+$/u, "")
      .match(/^(\d{2})-(\d{2})-(\d{2})$/u);
    const timeMatch = rawTime?.trim().match(/^(\d{1,2}):(\d{2})$/u);

    if (!dateMatch || !timeMatch) {
      return null;
    }

    const first = Number.parseInt(dateMatch[1], 10);
    const second = Number.parseInt(dateMatch[2], 10);
    const third = Number.parseInt(dateMatch[3], 10);
    const hour = Number.parseInt(timeMatch[1], 10);
    const minute = Number.parseInt(timeMatch[2], 10);

    if (
      second < 1 ||
      second > 12 ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }

    const candidates = [];

    if (third >= 1 && third <= 31) {
      candidates.push(
        zonedDateTimeToEpochSeconds({
          year: twoDigitYear(first),
          month: second,
          day: third,
          hour,
          minute,
        }),
      );
    }

    if (first >= 1 && first <= 31) {
      candidates.push(
        zonedDateTimeToEpochSeconds({
          year: twoDigitYear(third),
          month: second,
          day: first,
          hour,
          minute,
        }),
      );
    }

    return chooseClosestEpoch(candidates);
  };

  const epochToIso = (epochSeconds) =>
    Number.isInteger(epochSeconds)
      ? new Date(epochSeconds * 1_000).toISOString()
      : null;

  const getUrlIntegerFromPath = (rawUrl, pathSegment) => {
    if (!rawUrl) {
      return null;
    }

    const url = new URL(rawUrl, location.href);
    const match = url.pathname.match(new RegExp(`/${pathSegment}/(\\d+)`, "u"));
    return match ? parseInteger(match[1]) : null;
  };

  const getPostId = (rawUrl) => {
    if (!rawUrl) {
      return null;
    }

    const url = new URL(rawUrl, location.href);
    return parseInteger(url.searchParams.get("p")) || parseInteger(url.hash);
  };

  const getDateText = (dateEl) => {
    if (!dateEl) {
      return null;
    }

    const ownText = [...dateEl.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return ownText || null;
  };

  const normalizeAvatarUrl = (rawUrl) => {
    if (!rawUrl) {
      return null;
    }

    const url = new URL(rawUrl, location.href);
    if (url.pathname.endsWith("/forum/images/misc/unknown.gif")) {
      return null;
    }

    url.searchParams.delete("s");
    return url.toString();
  };

  const getViewsAndReplies = (item) => {
    const rawValue = item.querySelector(".views")?.textContent || "";
    const [rawReplies, rawViews] = rawValue.split("|");

    return {
      replies: parseInteger(rawReplies) ?? 0,
      views: parseInteger(rawViews) ?? 0,
      raw: rawValue.replace(/\s+/g, " ").trim() || null,
    };
  };

  return [...document.querySelectorAll("li.activitybit.forum_post")]
    .map((item, index) => {
      const dateEl = item.querySelector(".datetime .date");
      const timeEl = dateEl?.querySelector(".time");
      const memberEl = item.querySelector('.title a[href^="members/"]');
      const threadEl = item.querySelector('.title a[href^="threads/"]');
      const forumEl = item.querySelector('.title a[href^="forums/"]');
      const postLinkEl = item.querySelector(".fulllink a");
      const avatarImg = item.querySelector("img.avatar, .avatar img, img[src]");
      const dateRaw = getDateText(dateEl);
      const timeRaw = timeEl?.textContent?.trim() || null;
      const activityEpoch = parseActivityEpoch(dateRaw, timeRaw);
      const publishedAt = epochToIso(activityEpoch);
      const threadUrl = canonicalizeUrl(threadEl?.getAttribute("href"));
      const postUrl = canonicalizeUrl(postLinkEl?.getAttribute("href"), {
        keepPostPointer: true,
      });
      const url = postUrl || threadUrl;
      const topicId = getUrlIntegerFromPath(threadEl?.getAttribute("href"), "threads");
      const forumId = getUrlIntegerFromPath(forumEl?.getAttribute("href"), "forums");
      const memberId = getUrlIntegerFromPath(memberEl?.getAttribute("href"), "members");
      const { replies, views, raw: viewsRaw } = getViewsAndReplies(item);
      const title = threadEl?.textContent?.trim() || null;
      const fullTitleText =
        item.querySelector(".title")?.textContent?.replace(/\s+/g, " ").trim() ||
        "";
      const hasPoll = /με\s+δημοσκόπηση/iu.test(fullTitleText);
      const excerpt = item.querySelector(".excerpt")?.textContent?.trim() || "";

      if (!topicId || !title || !url || !publishedAt) {
        return null;
      }

      return {
        externalId: `topic_${topicId}`,
        title,
        url,
        score: replies + 1,
        commentsCount: replies,
        publishedAt,
        rank: index + 1,
        metadata: {
          topic_id: topicId,
          thread_url: threadUrl,
          post_url: postUrl,
          post_id: getPostId(postLinkEl?.getAttribute("href")),
          forum_id: forumId,
          forum_name: forumEl?.textContent?.trim() || null,
          member: memberEl?.textContent?.trim() || null,
          member_id: memberId,
          member_url: canonicalizeUrl(memberEl?.getAttribute("href")),
          avatar_url: normalizeAvatarUrl(avatarImg?.getAttribute("src")),
          excerpt,
          replies,
          views,
          views_raw: viewsRaw,
          has_poll: hasPoll,
          last_activity_at: publishedAt,
          activity_epoch: activityEpoch,
          activity_date_raw: dateRaw,
          activity_time_raw: timeRaw,
          crawled_at_epoch: crawlEpochSeconds,
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
  const min = config.adslgrTopicsRefreshMinMs;
  const max = config.adslgrTopicsRefreshMaxMs;
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
