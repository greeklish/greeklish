import assert from "node:assert/strict";
import test from "node:test";

process.env.BACKEND_BASE_URL ||= "http://127.0.0.1:3000";
process.env.BACKEND_INTERNAL_API_TOKEN ||= "test-token";

test("sends a crawl pass in one HTTP request", async () => {
  const { BackendClient } = await import("../src/lib/backend-client.js");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        crawl_id: "018f0000-0000-7000-8000-000000000001",
        external_ids: ["first", "second"],
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new BackendClient({
      baseUrl: "http://backend.test:3000",
      token: "secret",
    });
    await client.ingestCrawlPass({
      crawlId: "018f0000-0000-7000-8000-000000000001",
      topicSlug: "test-topic",
      sourceSlug: "reddit",
      crawledAt: "2026-06-07T01:00:00.000Z",
      items: [buildItem("first", 1), buildItem("second", 2)],
    });

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "http://backend.test:3000/internal/topics/test-topic/crawl-passes",
    );
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.items.length, 2);
    assert.deepEqual(
      body.items.map((item) => item.external_id),
      ["first", "second"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fans out a crawl pass to multiple backend targets", async () => {
  const { BackendClient } = await import("../src/lib/backend-client.js");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        crawl_id: "018f0000-0000-7000-8000-000000000002",
        external_ids: ["first"],
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new BackendClient({
      targets: [
        {
          name: "local",
          baseUrl: "http://local-backend.test:3000",
          token: "local-secret",
        },
        {
          name: "remote",
          baseUrl: "http://remote-backend.test:3000",
          token: "remote-secret",
        },
      ],
    });
    await client.ingestCrawlPass({
      crawlId: "018f0000-0000-7000-8000-000000000002",
      topicSlug: "test-topic",
      sourceSlug: "reddit",
      crawledAt: "2026-06-07T01:00:00.000Z",
      items: [buildItem("first", 1)],
    });

    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "http://local-backend.test:3000/internal/topics/test-topic/crawl-passes",
        "http://remote-backend.test:3000/internal/topics/test-topic/crawl-passes",
      ],
    );
    assert.equal(
      requests[0].options.headers["X-Internal-Token"],
      "local-secret",
    );
    assert.equal(
      requests[1].options.headers["X-Internal-Token"],
      "remote-secret",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function buildItem(externalId, rank) {
  return {
    externalId,
    title: externalId,
    url: `https://example.com/${externalId}`,
    score: rank,
    commentsCount: rank,
    publishedAt: "2026-06-07T00:00:00.000Z",
    rank,
  };
}
