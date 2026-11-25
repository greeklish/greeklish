import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfig } from "./config.js";

const config = loadConfig();

export async function enqueueCrawlPass({
  target,
  crawledAt,
  items,
  outboxRoot = config.backendOutboxRoot,
}) {
  await fs.mkdir(outboxRoot, { recursive: true });

  const timestamp = Date.parse(crawledAt);
  const filename = `${Number.isFinite(timestamp) ? timestamp : Date.now()}-${target.name}.json`;
  const filePath = path.join(outboxRoot, filename);
  const entry = {
    version: 2,
    crawlId: randomUUID(),
    targetName: target.name,
    source: target.source,
    topic: target.topic,
    crawledAt,
    items,
  };

  try {
    await fs.writeFile(filePath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  return filePath;
}

export async function flushCrawlPassOutbox({
  backendClient,
  signal,
  logger,
  outboxRoot = config.backendOutboxRoot,
}) {
  const files = await listOutboxFiles(outboxRoot);
  let completedPasses = 0;

  for (const filePath of files) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    const entry = await readEntry(filePath);
    if (!entry.crawlId) {
      entry.crawlId = randomUUID();
      delete entry.nextItemIndex;
      await writeEntry(filePath, entry);
    }
    logger(
      `replaying queued crawl ${entry.crawledAt} with ${entry.items.length} item(s)`,
    );

    try {
      await backendClient.upsertSource(entry.source);
      await backendClient.upsertTopic(entry.topic);

      const result = await backendClient.ingestCrawlPass({
        crawlId: entry.crawlId,
        topicSlug: entry.topic.slug,
        sourceSlug: entry.source.slug,
        crawledAt: entry.crawledAt,
        items: entry.items,
      });
      for (const externalId of result.external_ids) {
        const item = entry.items.find(
          (candidate) => candidate.externalId === externalId,
        );
        logger(`ingested ${externalId}${item ? ` rank=${item.rank}` : ""}`);
      }
      await fs.unlink(filePath);
      completedPasses += 1;
      logger(
        `stored queued crawl snapshot ${entry.crawledAt} with ${entry.items.length} item(s)`,
      );
    } catch (error) {
      return {
        completedPasses,
        pendingPasses: files.length - completedPasses,
        error,
      };
    }
  }

  return { completedPasses, pendingPasses: 0, error: null };
}

async function listOutboxFiles(outboxRoot) {
  try {
    const filenames = await fs.readdir(outboxRoot);
    return filenames
      .filter((filename) => filename.endsWith(".json"))
      .sort()
      .map((filename) => path.join(outboxRoot, filename));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readEntry(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeEntry(filePath, entry) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}
