import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "patchright";
import {
  buildTrendItems,
  extractVisibleTrendsFromDocument,
} from "../src/targets/x-trends.js";

let browser, page;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});
const card = (content, rank = 1) => `<div data-testid="trend" role="link">
  <div dir="ltr"><span aria-hidden="true">${rank}</span><span dir="ltr"> · </span><span>Trending in Greece</span></div>
  ${content}<button role="button"><span dir="ltr">More</span></button>
</div>`;
const related = `<div dir="ltr">Trending with <a href="/search?q=related"><span dir="ltr">Πουτιν</span></a></div>`;

test("reads the primary trend before related topics, never the Trending with caption", async () => {
  await page.setContent(
    card(`<div dir="ltr"><span>Κύριο θέμα</span></div>${related}`),
  );
  assert.deepEqual(await page.evaluate(extractVisibleTrendsFromDocument), [
    {
      rank: 1,
      label: "Κύριο θέμα",
      context: "Trending in Greece",
      postsText: null,
    },
  ]);
});
test("does not mistake a shared layout class on related topics for a hashtag title", async () => {
  await page.setContent(
    card(
      `<div dir="ltr"><span>Χωρίς hashtag</span></div><div class="r-18u37iz">${related}</div>`,
      2,
    ),
  );
  assert.equal(
    (await page.evaluate(extractVisibleTrendsFromDocument))[0].label,
    "Χωρίς hashtag",
  );
});
test("reads hashtags, plain names and auto/RTL direction without requiring opaque CSS classes", async () => {
  await page.setContent(
    [
      card(
        '<div class="r-18u37iz"><span dir="ltr">#Ελλάδα</span></div><div dir="ltr">12.5K posts</div>',
        1,
      ),
      card(
        '<div dir="auto"><span>Καλή Κυριακή</span></div><div dir="ltr">1,200 tweets</div>',
        2,
      ),
      card(
        '<div dir="rtl"><span>Ελληνικό θέμα</span></div><div dir="auto">200 αναρτήσεις</div>',
        3,
      ),
      card('<div dir="ltr">Posts about Greece</div>', 4),
      card('<div dir="ltr">Στάση εργασίας</div>', 5),
    ].join(""),
  );
  assert.deepEqual(
    (await page.evaluate(extractVisibleTrendsFromDocument)).map(
      ({ label, postsText }) => ({ label, postsText }),
    ),
    [
      { label: "#Ελλάδα", postsText: "12.5K posts" },
      { label: "Καλή Κυριακή", postsText: "1,200 tweets" },
      { label: "Ελληνικό θέμα", postsText: "200 αναρτήσεις" },
      { label: "Posts about Greece", postsText: null },
      { label: "Στάση εργασίας", postsText: null },
    ],
  );
});
test("skips incomplete cards containing only context, post counts and related links", async () => {
  await page.setContent(
    card(
      `<div class="r-18u37iz">${related}</div><div dir="ltr">10K posts</div>`,
    ),
  );
  assert.deepEqual(await page.evaluate(extractVisibleTrendsFromDocument), []);
});

test("deduplicates primary names across ranks before ingesting a crawl", () => {
  const items = buildTrendItems(
    [
      { rank: 1, label: "Ελλάδα", context: "Trending in Greece" },
      { rank: 2, label: "ΕΛΛΆΔΑ", context: "Trending in Greece" },
      { rank: 3, label: "Άλλο θέμα", context: "Trending in Greece" },
      { rank: 4, label: "Other country", context: "Trending in France" },
    ],
    "2026-10-11T12:00:00.000Z",
  );
  assert.deepEqual(
    items.map((item) => ({ title: item.title, rank: item.rank })),
    [
      { title: "Ελλάδα", rank: 1 },
      { title: "Άλλο θέμα", rank: 3 },
    ],
  );
  assert.equal(new URL(items[0].url).searchParams.get("q"), "Ελλάδα");
});
