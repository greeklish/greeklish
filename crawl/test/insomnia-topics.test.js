import assert from "node:assert/strict";
import test from "node:test";

import { extractInsomniaTopicsFromDocument } from "../src/targets/insomnia-topics.js";

test("extracts topics from the current Insomnia stream markup", () => {
  const topicLink = {
    href: "https://www.insomnia.gr/forums/topic/853711-ios-27/?do=getNewComment",
    textContent: "iOS 27",
    getAttribute(name) {
      return name === "href" ? this.href : null;
    },
  };
  const repliesItem = {
    textContent: "7,567 replies",
    querySelector(selector) {
      return selector === '[class*="fa-comment"]' ? {} : null;
    },
  };
  const streamItem = {
    getAttribute(name) {
      return name === "data-timestamp" ? "1788001002" : null;
    },
    querySelector(selector) {
      if (selector === 'a[data-linktype="link"][href*="/topic/"]') {
        return topicLink;
      }

      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("ipsStreamItem__stats")) {
        return [repliesItem];
      }

      return [];
    },
  };

  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === "li.ipsStreamItem" ? [streamItem] : [];
    },
  };
  globalThis.location = { origin: "https://www.insomnia.gr" };

  try {
    assert.deepEqual(extractInsomniaTopicsFromDocument(), [
      {
        externalId: "topic_853711",
        title: "iOS 27",
        url: "https://www.insomnia.gr/forums/topic/853711-ios-27/",
        score: 7_568,
        commentsCount: 7_567,
        publishedAt: "2026-08-29T10:56:42.000Z",
        rank: 1,
        metadata: {
          last_activity_at: "2026-08-29T10:56:42.000Z",
        },
      },
    ]);
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
});
