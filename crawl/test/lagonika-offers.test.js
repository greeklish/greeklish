import assert from "node:assert/strict";
import test from "node:test";

process.env.BACKEND_BASE_URL ||= "http://127.0.0.1:3000";
process.env.BACKEND_INTERNAL_API_TOKEN ||= "test-token";

const { buildLagonikaOfferUrl } = await import(
  "../src/targets/lagonika-offers.js"
);

test("builds Lagonika offer URLs from the offer category slug", () => {
  assert.equal(
    buildLagonikaOfferUrl({
      slug: "prosfores-super-market-apo-pempth-0207-ews-tetarth-0807",
      category: { slug: "super-market" },
    }),
    "https://www.lagonika.gr/super-market/prosfores-super-market-apo-pempth-0207-ews-tetarth-0807/",
  );
});

test("prefers the parent category slug when Lagonika includes one", () => {
  assert.equal(
    buildLagonikaOfferUrl({
      slug: "prosfores-super-market-apo-pempth-0207-ews-tetarth-0807",
      category: {
        slug: "eidh-super-market",
        parent: { slug: "super-market" },
      },
    }),
    "https://www.lagonika.gr/super-market/prosfores-super-market-apo-pempth-0207-ews-tetarth-0807/",
  );
});

test("prefers a rendered Lagonika listing link over category-derived paths", () => {
  assert.equal(
    buildLagonikaOfferUrl(
      {
        slug: "offer-slug",
        category: { slug: "prosfores" },
      },
      {
        "offer-slug": "https://www.lagonika.gr/super-market/offer-slug/?ref=list#title",
      },
    ),
    "https://www.lagonika.gr/super-market/offer-slug/",
  );
});

test("falls back to the historical prosfores path when no category is available", () => {
  assert.equal(
    buildLagonikaOfferUrl({ slug: "offer-slug" }),
    "https://www.lagonika.gr/prosfores/offer-slug/",
  );
});
