import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.BACKEND_BASE_URL ||= "http://127.0.0.1:3000";
process.env.BACKEND_INTERNAL_API_TOKEN ||= "test-token";

test("retries a crawl as one idempotent bulk request", async () => {
  const { enqueueCrawlPass, flushCrawlPassOutbox } = await import(
    "../src/lib/backend-outbox.js"
  );
  const outboxRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "crawl-backend-outbox-")
  );
  const calls = [];
  let backendUnavailable = true;
  const backendClient = {
    async upsertSource() {},
    async upsertTopic() {},
    async ingestCrawlPass(payload) {
      calls.push({
        crawlId: payload.crawlId,
        externalIds: payload.items.map((item) => item.externalId),
      });
      if (backendUnavailable) {
        throw new Error("backend unavailable");
      }
      return { external_ids: payload.items.map((item) => item.externalId) };
    },
  };
  const target = {
    name: "test-target",
    source: {
      slug: "reddit",
      displayName: "Reddit",
      baseUrl: "https://www.reddit.com",
    },
    topic: {
      slug: "test-topic",
      displayName: "Test topic",
      rankingStrategy: "external",
      feedSize: 50,
    },
  };
  const items = [
    buildItem("first", 1),
    buildItem("second", 2),
  ];

  try {
    await enqueueCrawlPass({
      target,
      crawledAt: "2026-06-07T01:00:00.000Z",
      items,
      outboxRoot,
    });

    const firstDelivery = await flushCrawlPassOutbox({
      backendClient,
      logger: () => {},
      outboxRoot,
    });
    assert.equal(firstDelivery.pendingPasses, 1);
    assert.equal(firstDelivery.error?.message, "backend unavailable");

    const [queuedFilename] = await fs.readdir(outboxRoot);
    const queuedEntry = JSON.parse(
      await fs.readFile(path.join(outboxRoot, queuedFilename), "utf8")
    );
    assert.match(queuedEntry.crawlId, /^[0-9a-f-]{36}$/);

    backendUnavailable = false;
    const secondDelivery = await flushCrawlPassOutbox({
      backendClient,
      logger: () => {},
      outboxRoot,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].crawlId, calls[1].crawlId);
    assert.deepEqual(calls[0].externalIds, ["first", "second"]);
    assert.deepEqual(calls[1].externalIds, ["first", "second"]);
    assert.equal(secondDelivery.completedPasses, 1);
    assert.equal(secondDelivery.pendingPasses, 0);
    assert.deepEqual(await fs.readdir(outboxRoot), []);
  } finally {
    await fs.rm(outboxRoot, { recursive: true, force: true });
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
