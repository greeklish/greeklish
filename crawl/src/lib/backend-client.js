import { loadConfig } from "./config.js";

const config = loadConfig();

export class BackendClient {
  constructor(options = {}) {
    this.targets =
      options.targets ||
      (options.baseUrl || options.token
        ? [
            {
              name: options.name || "backend",
              baseUrl: options.baseUrl || config.backendBaseUrl,
              token: options.token || config.backendInternalApiToken,
            },
          ]
        : config.backendTargets);
  }

  async upsertSource(source) {
    return this.request("PUT", `/internal/sources/${source.slug}`, {
      display_name: source.displayName,
      base_url: source.baseUrl,
    });
  }

  async upsertTopic(topic) {
    const body = {
      display_name: topic.displayName,
      ranking_strategy: topic.rankingStrategy,
    };

    if (topic.feedSize != null) {
      body.feed_size = topic.feedSize;
    }

    if (topic.hotGravity != null) {
      body.hot_gravity = topic.hotGravity;
    }

    return this.request("PUT", `/internal/topics/${topic.slug}`, body);
  }

  async upsertTopicItem({ topicSlug, sourceSlug, externalId, item }) {
    const body = {
      title: item.title,
      url: item.url,
      score: item.score,
      published_at: item.publishedAt,
    };

    if (item.crawledAt) {
      body.crawled_at = item.crawledAt;
    }

    if (Number.isInteger(item.rank) && item.rank > 0) {
      body.rank = item.rank;
    }

    if (item.metadata) {
      body.metadata = item.metadata;
    }

    return this.request(
      "PUT",
      `/internal/topics/${topicSlug}/items/${sourceSlug}/${externalId}`,
      body,
    );
  }

  async createCrawlSnapshot({ topicSlug, sourceSlug, crawledAt, items }) {
    return this.request(
      "POST",
      `/internal/topics/${topicSlug}/crawl-snapshots`,
      {
        source_slug: sourceSlug,
        crawled_at: crawledAt,
        items: items.map((item) => ({
          external_id: item.externalId,
          title: item.title,
          url: item.url,
          score: item.score,
          rank: item.rank,
          comments_count: Number.isInteger(item.commentsCount)
            ? item.commentsCount
            : null,
          nsfw: item.nsfw ? true : null,
          published_at: item.publishedAt,
          metadata: buildItemMetadata(item),
        })),
      },
    );
  }

  async ingestCrawlPass({ crawlId, topicSlug, sourceSlug, crawledAt, items }) {
    return this.request("POST", `/internal/topics/${topicSlug}/crawl-passes`, {
      crawl_id: crawlId,
      source_slug: sourceSlug,
      crawled_at: crawledAt,
      items: items.map((item) => ({
        external_id: item.externalId,
        title: item.title,
        url: item.url,
        score: item.score,
        comments_count: Number.isInteger(item.commentsCount)
          ? item.commentsCount
          : null,
        nsfw: item.nsfw ? true : null,
        rank: item.rank,
        published_at: item.publishedAt,
        metadata: buildItemMetadata(item),
      })),
    });
  }

  async rerankTopic(topicSlug) {
    return this.request("POST", `/internal/topics/${topicSlug}/rerank`);
  }

  async request(method, pathname, body = undefined) {
    const results = [];
    const errors = [];

    for (const target of this.targets) {
      try {
        results.push(await this.requestTarget(target, method, pathname, body));
      } catch (error) {
        errors.push({ target, error });
      }
    }

    if (errors.length) {
      throw new Error(
        `Backend request failed for ${errors
          .map(
            ({ target, error }) =>
              `${target.name} (${target.baseUrl}): ${error.message}`,
          )
          .join("; ")}`,
      );
    }

    return results[0] ?? null;
  }

  async requestTarget(target, method, pathname, body = undefined) {
    const url = new URL(pathname, target.baseUrl);
    let response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": target.token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new Error(
        `Backend request failed: ${method} ${url.href} -> ${error.message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Backend request failed: ${method} ${url.href} -> ${response.status} ${text}`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return null;
    }

    return response.json();
  }
}

function buildItemMetadata(item) {
  const metadata =
    item.metadata && typeof item.metadata === "object"
      ? { ...item.metadata }
      : {};

  if (Number.isInteger(item.commentsCount)) {
    metadata.comments_count = item.commentsCount;
  }
  if (item.nsfw) {
    metadata.nsfw = true;
  }
  if (
    Number.isInteger(item.recentRepliesCount) &&
    item.recentRepliesCount > 0
  ) {
    metadata.recent_replies_count = item.recentRepliesCount;
  }
  if (Number.isFinite(item.recentReplyBoost) && item.recentReplyBoost > 0) {
    metadata.recent_reply_boost = item.recentReplyBoost;
  }
  if (
    Number.isFinite(item.observedIntervalHours) &&
    item.observedIntervalHours > 0
  ) {
    metadata.observed_interval_hours = item.observedIntervalHours;
  }

  return Object.keys(metadata).length ? metadata : null;
}
