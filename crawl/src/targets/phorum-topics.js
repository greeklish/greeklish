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
const MIN_READY_TOPIC_COUNT = 20;
const INCOMPLETE_PAGE_RETRY_MS = 5_000;
const INCOMPLETE_PAGE_BROWSER_RESTART_ATTEMPTS = 3;
const PHORUM_TOPICS_URL =
  "https://www.phorum.com.gr/search.php?search_id=active_topics";
const ACTIVITY_HISTORY_PATH = path.resolve(
  config.backendOutboxRoot,
  "..",
  "phorum-topics-activity-history.json",
);
const RECENT_REPLY_WINDOW_HOURS = 24;
const MIN_ACTIVITY_INTERVAL_HOURS = 5 / 60;
const MAX_RECENT_REPLY_MULTIPLIER = 48;

export const target = {
  name: "phorum-topics",
  site: "phorum",
  preserveBrowserData: true,
  browserContextName: "phorum-browser",
  source: {
    slug: "phorum",
    displayName: "phorum",
    baseUrl: "https://www.phorum.com.gr",
  },
  topic: {
    slug: "phorum-topics",
    displayName: "phorum",
    rankingStrategy: "hot",
    feedSize: 50,
    hotGravity: 1.8,
  },
  listingUrl: PHORUM_TOPICS_URL,
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
      `[crawl:${target.name}] keeping browser open and refreshing every ${config.phorumTopicsRefreshMinMs}-${config.phorumTopicsRefreshMaxMs}ms; press Ctrl+C to finish`,
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
    `[crawl:${target.name}] waiting for phpBB active topic list before extraction`,
  );
  await page.waitForSelector("ul.topiclist.topics li.row", {
    timeout: 15_000,
  });
  await page.waitForTimeout(1_000);

  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const topics = await extractTopics(page, crawlEpochSeconds, signal);
  console.log(
    `[crawl:${target.name}] active topic list has ${topics.length} valid topic(s)`,
  );

  if (topics.length < MIN_READY_TOPIC_COUNT) {
    throw new Error(
      `phorum active topic list incomplete: found ${topics.length}, expected at least ${MIN_READY_TOPIC_COUNT}`,
    );
  }

  return topics;
}

async function extractTopics(page, crawlEpochSeconds, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const topics = await page.evaluate(
    extractPhorumTopicsFromDocument,
    crawlEpochSeconds,
  );

  if (!topics.length) {
    throw new Error("No phorum active topics found on the page");
  }

  return topics;
}

export function extractPhorumTopicsFromDocument(crawlEpochSeconds) {
  const TIME_ZONE = "Europe/Athens";
  const POSTS_PER_PAGE = 15;
  const GREEK_MONTHS = new Map([
    ["ιαν", 1],
    ["φεβ", 2],
    ["μαρ", 3],
    ["απρ", 4],
    ["μαι", 5],
    ["ιουν", 6],
    ["ιουλ", 7],
    ["αυγ", 8],
    ["σεπ", 9],
    ["οκτ", 10],
    ["νοε", 11],
    ["δεκ", 12],
  ]);

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

  const normalizeGreekKey = (value) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();

  const getGreekMonth = (value) => {
    const key = normalizeGreekKey(value);

    if (key.startsWith("ιουν")) return 6;
    if (key.startsWith("ιουλ")) return 7;
    if (key.startsWith("μαι")) return 5;

    return GREEK_MONTHS.get(key.slice(0, 3)) || null;
  };

  const canonicalizeUrl = (rawUrl, { keepHash = false } = {}) => {
    if (!rawUrl) {
      return null;
    }

    const url = new URL(rawUrl, location.origin);
    if (!keepHash) {
      url.hash = "";
    }
    url.searchParams.delete("sid");
    return `${url.origin}${decodeURIComponent(url.pathname)}${url.search}${url.hash}`;
  };

  const getUrlIntegerParam = (rawUrl, param) => {
    if (!rawUrl) {
      return null;
    }

    const url = new URL(rawUrl, location.origin);
    return parseInteger(url.searchParams.get(param));
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

  const parseGreekAbsoluteEpoch = (rawValue) => {
    const value = rawValue.trim().replace(/\s+/g, " ");
    const match = value.match(
      /(\d{1,2})\s+(\S+)\s+(\d{4}),\s+(\d{1,2}):(\d{2})/,
    );
    if (!match) {
      return null;
    }

    const [, day, rawMonth, year, hour, minute] = match;
    const month = getGreekMonth(rawMonth);
    if (!month) {
      return null;
    }

    return zonedDateTimeToEpochSeconds({
      year: Number.parseInt(year, 10),
      month,
      day: Number.parseInt(day, 10),
      hour: Number.parseInt(hour, 10),
      minute: Number.parseInt(minute, 10),
    });
  };

  const parseGreekRelativeEpoch = (rawValue) => {
    const value = rawValue.trim().replace(/\s+/g, " ");
    const crawlParts = getAthensParts(crawlEpochSeconds);
    let match = value.match(/^Σήμερα,\s*(\d{1,2}):(\d{2})$/u);
    if (match) {
      return zonedDateTimeToEpochSeconds({
        year: crawlParts.year,
        month: crawlParts.month,
        day: crawlParts.day,
        hour: Number.parseInt(match[1], 10),
        minute: Number.parseInt(match[2], 10),
      });
    }

    match = value.match(/^Χθες,\s*(\d{1,2}):(\d{2})$/u);
    if (match) {
      const yesterday = new Date(
        zonedDateTimeToEpochSeconds({
          year: crawlParts.year,
          month: crawlParts.month,
          day: crawlParts.day,
          hour: 12,
          minute: 0,
        }) *
          1_000 -
          86_400_000,
      );
      const parts = getAthensParts(Math.floor(yesterday.getTime() / 1_000));
      return zonedDateTimeToEpochSeconds({
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: Number.parseInt(match[1], 10),
        minute: Number.parseInt(match[2], 10),
      });
    }

    if (/λιγότερο\s+από\s+(ένα|1)\s+λεπτ/u.test(value)) {
      return crawlEpochSeconds;
    }

    if (/μόλις|τώρα|πριν\s+λίγο/u.test(value)) {
      return crawlEpochSeconds;
    }

    match = value.match(/^(\d+)\s+δευτερ/u);
    if (match) {
      return crawlEpochSeconds - Number.parseInt(match[1], 10);
    }

    match = value.match(/^(\d+)\s+λεπτ/u);
    if (match) {
      return crawlEpochSeconds - Number.parseInt(match[1], 10) * 60;
    }

    match = value.match(/^(\d+)\s+ώρ/u);
    if (match) {
      return crawlEpochSeconds - Number.parseInt(match[1], 10) * 3_600;
    }

    match = value.match(/^(\d+)\s+μέρ/u);
    if (match) {
      return crawlEpochSeconds - Number.parseInt(match[1], 10) * 86_400;
    }

    return parseGreekAbsoluteEpoch(value);
  };

  const epochToIso = (epochSeconds) =>
    Number.isInteger(epochSeconds)
      ? new Date(epochSeconds * 1_000).toISOString()
      : null;

  const getCreatedAtRaw = (metaBlock) => {
    if (!metaBlock) {
      return null;
    }

    const text = metaBlock.textContent?.replace(/\s+/g, " ").trim() || "";
    const match = text.match(/»\s*([^»]+?)\s*»\s*σε\s+/u);
    return match?.[1]?.trim() || null;
  };

  const getLastPostRaw = (lastPostCell) => {
    if (!lastPostCell) {
      return null;
    }

    const breakElement = lastPostCell.querySelector("br");
    if (breakElement) {
      const parts = [];
      let node = breakElement.nextSibling;

      while (node) {
        parts.push(node.textContent || "");
        node = node.nextSibling;
      }

      const textAfterBreak = parts.join(" ").replace(/\s+/g, " ").trim();
      if (textAfterBreak) {
        return textAfterBreak;
      }
    }

    const clone = lastPostCell.cloneNode(true);
    clone.querySelectorAll("dfn, a, i, .sr-only").forEach((node) => node.remove());
    return (
      clone.textContent
        ?.replace(/\bαπό\b/giu, "")
        .replace(/\s+/g, " ")
        .trim() || null
    );
  };

  const getLastPage = (row) => {
    const pageNumbers = [...row.querySelectorAll(".pagination ul li a.button")]
      .map((link) => parseInteger(link.textContent || ""))
      .filter((value) => value !== null);

    return pageNumbers.length ? Math.max(...pageNumbers) : null;
  };

  return [...document.querySelectorAll("ul.topiclist.topics > li.row")]
    .map((row, index) => {
      const descriptor = row.querySelector("dl.row-item");
      const titleLink = row.querySelector("a.topictitle");
      const metaBlock = row.querySelector(".responsive-hide.left-box");
      const postsCell = row.querySelector("dd.posts");
      const viewsCell = row.querySelector("dd.views");
      const lastPostCell = row.querySelector("dd.lastpost");
      const lastPostLink = lastPostCell?.querySelector('a[href*="p="]');
      const authorLink = metaBlock?.querySelector("a.username");
      const forumLink = metaBlock?.querySelector('a[href*="viewforum.php"]');
      const lastPosterLink = lastPostCell?.querySelector("a.username");

      const topicId = getUrlIntegerParam(titleLink?.getAttribute("href"), "t");
      const forumId = getUrlIntegerParam(titleLink?.getAttribute("href"), "f");
      const title = titleLink?.textContent?.trim() || null;
      const url = canonicalizeUrl(titleLink?.getAttribute("href"));
      const lastPostUrl = canonicalizeUrl(lastPostLink?.getAttribute("href"), {
        keepHash: true,
      });
      const replies = parseInteger(postsCell?.textContent || "") ?? 0;
      const views = parseInteger(viewsCell?.textContent || "") ?? 0;
      const createdAtRaw = getCreatedAtRaw(metaBlock);
      const createdAtEpoch = createdAtRaw
        ? parseGreekRelativeEpoch(createdAtRaw)
        : null;
      const lastPostRaw = getLastPostRaw(lastPostCell);
      const lastPostEpoch = lastPostRaw
        ? parseGreekRelativeEpoch(lastPostRaw)
        : null;
      const createdAt = epochToIso(createdAtEpoch);
      const lastActivityAt = epochToIso(
        lastPostEpoch || createdAtEpoch || crawlEpochSeconds,
      );
      const publishedAt = lastActivityAt;
      const lastPage = getLastPage(row);
      const totalPages =
        lastPage || Math.max(1, Math.ceil((replies + 1) / POSTS_PER_PAGE));

      if (!topicId || !forumId || !title || !url || !publishedAt) {
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
          forum_id: forumId,
          forum_name: forumLink?.textContent?.trim() || null,
          author: authorLink?.textContent?.trim() || null,
          author_id: getUrlIntegerParam(authorLink?.getAttribute("href"), "u"),
          created_at_epoch: createdAtEpoch,
          created_at: createdAt,
          created_at_raw: createdAtRaw,
          replies,
          views,
          last_poster: lastPosterLink?.textContent?.trim() || null,
          last_poster_id: getUrlIntegerParam(
            lastPosterLink?.getAttribute("href"),
            "u",
          ),
          last_post_id: getUrlIntegerParam(
            lastPostLink?.getAttribute("href"),
            "p",
          ),
          last_post_url: lastPostUrl,
          last_post_epoch: lastPostEpoch,
          last_activity_at: lastActivityAt,
          last_post_raw: lastPostRaw,
          crawled_at_epoch: crawlEpochSeconds,
          total_pages: totalPages,
          is_unread: descriptor?.classList.contains("topic_unread") || false,
          is_hot: descriptor?.classList.contains("topic_unread_hot") || false,
          has_attachment: Boolean(metaBlock?.querySelector(".fa-paperclip")),
          has_poll: Boolean(metaBlock?.querySelector(".fa-bar-chart")),
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
  const min = config.phorumTopicsRefreshMinMs;
  const max = config.phorumTopicsRefreshMaxMs;
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
