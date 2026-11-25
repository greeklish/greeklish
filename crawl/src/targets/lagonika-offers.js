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
const LAGONIKA_BASE_URL = "https://www.lagonika.gr";
const LAGONIKA_OFFERS_URL = `${LAGONIKA_BASE_URL}/`;
const LAGONIKA_FALLBACK_OFFER_SECTION_SLUG = "prosfores";
const LAGONIKA_PAGE_COUNT = 3;
const MIN_READY_OFFER_COUNT = 20;
const INCOMPLETE_PAGE_RETRY_MS = 5_000;
const INCOMPLETE_PAGE_BROWSER_RESTART_ATTEMPTS = 3;

export const target = {
  name: "lagonika-offers",
  site: "lagonika",
  preserveBrowserData: true,
  browserContextName: "lagonika-browser",
  source: {
    slug: "lagonika",
    displayName: "Lagonika",
    baseUrl: "https://www.lagonika.gr",
  },
  topic: {
    slug: "lagonika-offers",
    displayName: "lagonika",
    rankingStrategy: "external",
    feedSize: 50,
  },
  listingUrl: `${LAGONIKA_OFFERS_URL}?dtype=all`,
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
      `[crawl:${target.name}] keeping browser open and refreshing every ${config.lagonikaOffersRefreshMinMs}-${config.lagonikaOffersRefreshMaxMs}ms; press Ctrl+C to finish`,
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

async function runCrawlPass(getPage, restartBrowser, pass, signal) {
  console.log(`[crawl:${target.name}] starting pass ${pass}`);

  const offers = await loadOffersForCrawlPass(getPage, restartBrowser, signal);
  const crawledAt = new Date().toISOString();

  console.log(
    `[crawl:${target.name}] extracted ${offers.length} offer(s) from ${target.listingUrl}`,
  );

  await enqueueCrawlPass({ target, crawledAt, items: offers });
  console.log(
    `[crawl:${target.name}] queued crawl ${crawledAt} with ${offers.length} item(s) for backend delivery`,
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
    count: delivery.error ? 0 : offers.length,
    items: offers,
  };
}

async function loadOffersForCrawlPass(getPage, restartBrowser, signal) {
  let loadAttempt = 1;
  let page = getPage();

  for (;;) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (page.isClosed()) {
      throw new Error("Page has been closed");
    }

    try {
      const offers = [];

      for (const dtype of ["all", "sxoliasmena"]) {
        for (let pageNumber = 1; pageNumber <= LAGONIKA_PAGE_COUNT; pageNumber += 1) {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }

          const pageUrl = getListingPageUrl(dtype, pageNumber);
          const pageOffers = await loadOffersPage(page, pageUrl, dtype, pageNumber);
          offers.push(...pageOffers);
        }
      }

      const mergedOffers = mergeOfferBatches(offers);
      console.log(
        `[crawl:${target.name}] merged ${mergedOffers.length} unique offer(s) from ${LAGONIKA_PAGE_COUNT} all page(s) and ${LAGONIKA_PAGE_COUNT} latest-commented page(s)`,
      );

      if (mergedOffers.length < MIN_READY_OFFER_COUNT) {
        throw new Error(
          `Lagonika feed incomplete: found ${mergedOffers.length}, expected at least ${MIN_READY_OFFER_COUNT}`,
        );
      }

      return mergedOffers;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

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
        page = await restartBrowser(`proxy/network listing error: ${error.message}`);
        loadAttempt = 1;
        continue;
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

async function loadOffersPage(page, pageUrl, dtype, pageNumber) {
  const response = await withRetries(
    async () =>
      page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }),
    {
      maxRetries: 3,
      onRetry: ({ attempt, error, waitMs }) => {
        console.warn(
          `[crawl:${target.name}] ${dtype} page ${pageNumber} request failed on attempt ${attempt}: ${error.message}; retrying in ${waitMs}ms`,
        );
      },
    },
  );

  console.log(
    `[crawl:${target.name}] opened ${pageUrl} with status ${response?.status() ?? "unknown"}`,
  );

  await page.waitForSelector("#__NEXT_DATA__", {
    state: "attached",
    timeout: 15_000,
  });

  const offers = await extractOffers(page, dtype, pageNumber);
  console.log(
    `[crawl:${target.name}] ${dtype} page ${pageNumber} has ${offers.length} valid offer(s)`,
  );

  if (!offers.length) {
    throw new Error(`No Lagonika offers found on ${dtype} page ${pageNumber}`);
  }

  return offers;
}

function getListingPageUrl(dtype, pageNumber) {
  const url = new URL(LAGONIKA_OFFERS_URL);
  url.searchParams.set("dtype", dtype);
  if (pageNumber > 1) {
    url.searchParams.set("pg", String(pageNumber));
  }

  return url.toString();
}

async function extractOffers(page, dtype, pageNumber) {
  const { posts, offerLinksBySlug } = await page.evaluate(
    () => {
      const dataText = document.getElementById("__NEXT_DATA__")?.textContent;
      if (!dataText) {
        throw new Error("__NEXT_DATA__ was not found");
      }

      const data = JSON.parse(dataText);
      const posts = data?.props?.pageProps?.posts;
      if (!Array.isArray(posts)) {
        throw new Error("__NEXT_DATA__.props.pageProps.posts is not an array");
      }

      const offerLinksBySlug = {};
      for (const anchor of document.querySelectorAll("a[href]")) {
        try {
          const url = new URL(anchor.getAttribute("href"), window.location.origin);
          if (url.origin !== window.location.origin) {
            continue;
          }

          const pathSegments = url.pathname.split("/").filter(Boolean);
          const slug = pathSegments[pathSegments.length - 1];
          if (!slug || offerLinksBySlug[slug]) {
            continue;
          }

          url.search = "";
          url.hash = "";
          offerLinksBySlug[slug] = url.toString();
        } catch {}
      }

      return { posts, offerLinksBySlug };
    },
  );

  return normalizeLagonikaOffers({
    posts,
    dtype,
    pageNumber,
    offerLinksBySlug,
  });
}

export function normalizeLagonikaOffers({
  posts,
  dtype,
  pageNumber,
  offerLinksBySlug = {},
}) {
  return posts
    .map((offer, index) => {
      if (!offer || typeof offer !== "object") {
        return null;
      }

      const id = normalizeNumber(offer.id, null);
      const title = normalizeString(offer.title);
      const url = buildLagonikaOfferUrl(offer, offerLinksBySlug);
      const publishedAt =
        [offer.createDate, offer.listDate, offer.updated_at].find(isValidIsoDate) || null;

      if (!Number.isInteger(id) || !title || !url || !publishedAt) {
        return null;
      }

      const price = normalizeNumber(offer.price, 0);
      const commentsCount = normalizeNumber(offer.commentsCount, null);
      const score = normalizeNumber(offer.voting, 0);
      const listDate = isValidIsoDate(offer.listDate) ? offer.listDate : null;
      const createDate = isValidIsoDate(offer.createDate) ? offer.createDate : null;
      const rank = (pageNumber - 1) * posts.length + index + 1;

      return {
        externalId: String(id),
        title,
        url,
        score,
        commentsCount: Number.isInteger(commentsCount) ? commentsCount : null,
        publishedAt,
        rank,
        metadata: {
          source_type: "lagonika_offer",
          listing_dtype: dtype,
          all_rank: dtype === "all" ? rank : null,
          commented_rank: dtype === "sxoliasmena" ? rank : null,
          slug: normalizeString(offer.slug),
          store_name: normalizeString(offer.store?.name),
          store_slug: normalizeString(offer.store?.slug),
          category_name: normalizeString(offer.category?.name),
          category_slug: normalizeString(offer.category?.slug),
          price,
          price_type: normalizeString(offer.pricetype),
          discount_code: normalizeString(offer.discountcode),
          expires_at: isValidIsoDate(offer.todate) ? offer.todate : null,
          valid_from: isValidIsoDate(offer.fromdate) ? offer.fromdate : null,
          listed_at: listDate,
          created_at: createDate,
          updated_at: isValidIsoDate(offer.updated_at) ? offer.updated_at : null,
          relisted: Boolean(listDate && createDate && listDate !== createDate),
          expired: offer.expired === true,
          origin: normalizeString(offer.origin),
          affiliate_link: normalizeString(offer.affiliateLink),
          image_url: getImageUrl(offer),
          featured: offer.featured === true,
          sticky: Number.isFinite(offer.sticky) ? offer.sticky : null,
          lock_comments: offer.lockComments === true,
          lock_votings: offer.lockVotings === true,
          user_name: normalizeString(offer.user?.displayName || offer.user?.username),
        },
      };
    })
    .filter(Boolean);
}

export function buildLagonikaOfferUrl(offer, offerLinksBySlug = {}) {
  const slug = normalizePathSegment(offer?.slug);
  if (!slug) {
    return null;
  }

  const renderedLink = getRenderedOfferLink(slug, offerLinksBySlug);
  if (renderedLink) {
    return renderedLink;
  }

  const sectionSlug = getOfferSectionSlug(offer);
  return `${LAGONIKA_BASE_URL}/${sectionSlug}/${slug}/`;
}

function getRenderedOfferLink(slug, offerLinksBySlug) {
  const href =
    offerLinksBySlug instanceof Map
      ? offerLinksBySlug.get(slug)
      : offerLinksBySlug?.[slug];
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, LAGONIKA_BASE_URL);
    if (url.origin !== LAGONIKA_BASE_URL) {
      return null;
    }

    const pathSegments = url.pathname.split("/").filter(Boolean);
    if (pathSegments[pathSegments.length - 1] !== slug) {
      return null;
    }

    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function getOfferSectionSlug(offer) {
  const category = offer?.category;
  const candidates = [
    category?.parent?.slug,
    category?.parentCategory?.slug,
    category?.root?.slug,
    category?.main?.slug,
    offer?.parentCategory?.slug,
    category?.slug,
    LAGONIKA_FALLBACK_OFFER_SECTION_SLUG,
  ];

  for (const candidate of candidates) {
    const slug = normalizePathSegment(candidate);
    if (slug) {
      return slug;
    }
  }

  return LAGONIKA_FALLBACK_OFFER_SECTION_SLUG;
}

function getImageUrl(offer) {
  if (!Array.isArray(offer.image)) {
    return null;
  }

  const firstImage = offer.image.find(
    (image) => image && typeof image.url === "string" && image.url.trim(),
  );
  return firstImage?.url.trim() || null;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePathSegment(value) {
  return normalizeString(value)?.replace(/^\/+|\/+$/g, "") || null;
}

function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || !value) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

function mergeOfferBatches(offers) {
  const offersById = new Map();
  const offerIds = [];

  for (const offer of offers) {
    if (!offersById.has(offer.externalId)) {
      offerIds.push(offer.externalId);
      offersById.set(offer.externalId, offer);
      continue;
    }

    const previousOffer = offersById.get(offer.externalId);
    offersById.set(offer.externalId, {
      ...previousOffer,
      ...offer,
      rank: previousOffer.rank,
      metadata: {
        ...previousOffer.metadata,
        ...offer.metadata,
        listing_dtype: previousOffer.metadata?.listing_dtype || offer.metadata?.listing_dtype,
        all_rank: previousOffer.metadata?.all_rank ?? offer.metadata?.all_rank ?? null,
        commented_rank:
          previousOffer.metadata?.commented_rank ?? offer.metadata?.commented_rank ?? null,
      },
    });
  }

  return offerIds.map((externalId, index) => ({
    ...offersById.get(externalId),
    rank: index + 1,
  }));
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
  const min = config.lagonikaOffersRefreshMinMs;
  const max = config.lagonikaOffersRefreshMaxMs;
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
