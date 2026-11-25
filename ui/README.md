# Greeklish UI

Svelte frontend for Greeklish. Licensed under AGPL-3.0-or-later; see [LICENSE](../LICENSE).

## UI palette

Use the **Summer Dream** palette for UI work: turquoise shades with creamy yellow, soft
peach and coral for a sunny, tropical feel.

| Color         | Hex       | Use                                                                            |
| ------------- | --------- | ------------------------------------------------------------------------------ |
| Cerulean      | `#0081a7` | Rich aquatic blue-green for depth and emphasis.                                |
| Tropical Teal | `#00afb9` | Vivid teal for online/active states, including the pulsating status indicator. |
| Light Yellow  | `#fdfcdc` | Soft yellow for airy, gentle surfaces.                                         |
| Soft Apricot  | `#fed9b7` | Warm peach for inviting supporting surfaces.                                   |
| Vibrant Coral | `#f07167` | Coral for offline/error states, including the static status indicator.         |

## Hidden UI

The `.timeline` row is intentionally hidden in `src/routes/layout.css`. It still exists in
`src/routes/+page.svelte` and contains feed status metadata. Restore it by changing
`.timeline` from `display: none` back to a visible layout if that row is needed again.

## Development

From the repository root:

```sh
npm --prefix ui ci
npm --prefix ui run dev
```

The bundled `grhyph/js` dependency is resolved locally. See the [root setup guide](../README.md)
for the backend and database. To build the static frontend, run `npm --prefix ui run build`.

## Prerendered feed data

The index route is prerendered with only the latest feed snapshot for its initial HTML. Keep the
backend running during `npm run build` and set `PRERENDER_WS_URL` when it is not available at
`ws://127.0.0.1:3000/ws`. After hydration, local development connects to port `3000` on
`localhost` or `127.0.0.1`; other hosts connect to `/ws` on the same origin that served the UI.
Timeline controls remain disabled until the latest two days of snapshot history arrive. Set
`PUBLIC_WS_URL` only when the browser should use a different WebSocket URL.

## Guest comments

The button before each headline shows its approved Greeklish comment count, including zero.
Opening a thread highlights the corresponding news row. Drafts are retained per article until
submitted or the page is reloaded.

The toolbar's **Συζητήσεις** button opens all discussions with published comments, newest activity
first, including articles that have left the current feeds. Select a discussion to read or reply,
and use **Όλες οι συζητήσεις** to return to the list. The button pulses with theme colors while
closed and respects the motion setting and OS preference. **Πληροφορίες** and **Ρυθμίσεις** also have
visible labels.

Phones use a bottom sheet that can be dismissed by its close button, scrim, Escape, or a downward
drag on the handle. Tablets and narrower desktops use an overlay. A desktop rail pushes the feed
only when there is room to retain its current column count (at least 1540px of usable width for two
columns, or 2060px for three). Opening and closing animate the reserved space together with the
rail. Both the motion setting and the operating system's reduced-motion preference are respected.

The comments API defaults to the page origin; Vite proxies `/api` to the local backend in development.
Set `PUBLIC_API_URL` only for a separate HTTP endpoint.

Approved comments have **Απάντηση** and **Κοινοποίηση** actions. Replies keep a quote of the
parent when it remains visible; canceling a reply or a failed submission preserves the draft.
Shared links use `#σχόλια/<topic>/<external-id>/<comment-uuid>` and highlight that comment. The
copied link keeps letters and digits of any script literal, so a Greek or Cyrillic fragment reads as
words; only the `/` separator, ASCII punctuation and invisible characters are percent-encoded. The
URL parser re-encodes the fragment it stores in `location.hash`, so both forms are accepted on the
way back in.
The backend supplies titles and source URLs for archived articles as well as current feed items.

After commenting, **Απαντήσεις μου** shows direct replies to the browser's anonymous identity,
including unread indicators and read-all controls. It needs no account or notification permission.
The inbox covers the last 90 days; clearing browser data loses access to that anonymous identity.

Web Push is optional for each individual comment. The frontend requests a subscription only from
an explicit click, then enables that comment's watch. Submitting or loading the page never requests
permission. Settings can disable every watch on this device. Backend VAPID configuration is required
before opt-in controls appear. iOS/iPadOS users need a supported Home Screen web app and may have a
separate anonymous identity there. The service worker only handles push/click events: it does not
cache pages, feeds, APIs, or private comment data. Notification text is generic.

`npm run test:replies` exercises anonymous replies, mobile and desktop layouts, notification gestures,
per-comment opt-in, reload/device-disable, denial/unsupported/iOS guidance, error recovery, deep links,
and sharing with mocked browser push services and API responses. `npm run test:reply-worker` checks
notification visibility, retry tags, private content exclusion and click URL handling. These do not
replace a real-device delivery check with Apple, Mozilla or Google's push service.

Enter ↑ ↑ ↓ ↓ ← → ← → B A outside a text field to open the moderator password dialog. Successful
login opens the console, and its toolbar button lets moderators return to it after reading a thread.
Authentication and the console's visibility are separate; being logged in does not replace public
comment threads with moderation views.

On a touchscreen, swipe **up, up, down, down, left, right, left, right**, then type **B A** into the
small field that opens. The directions describe finger movement, and page scrolling stays enabled.
Each swipe needs at least 48 pixels of travel in under 700ms, with no more than 2.5 seconds between
swipes. The password field opens empty after the two letters.

## Comments UI regression checks

With the backend and `npm run dev` running:

```sh
npx playwright install chromium
npm run test:comments-ui
```

`UI_REVIEW_BASE_URL` overrides the default `http://127.0.0.1:5173`.
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects an already installed Chromium binary.
Animation samples are saved under `test-results/comments-ui` (override with `UI_REVIEW_OUTPUT`).
The tests use DOM, layout and interaction assertions without screenshots.

The suite checks phone, tablet, desktop and ultrawide sizes, exact layout breakpoints, short and
landscape viewports, opening/closing frame continuity, focus restoration, modal scroll locking,
rapid reversals, article drafts, visible counts, delayed captcha preparation, moderator navigation,
drag-to-dismiss, and reduced motion. Comment submissions and moderator actions use intercepted
fixture responses; the suite never publishes test comments or changes real moderation decisions.

The composer shows a live countdown during posting cooldowns, disables repeat sends, and keeps
the draft when a request is rejected. Article-specific limits leave other articles available.
The moderation console filters the full database by feed, status, commenter name or exact identity,
and comment/title text. Click a commenter to filter by identity; click a feed to select it.
Search applies text filters, dropdowns apply immediately, and More preserves all filters.
The same feed/author/text filters carry over to history.

Run `npm run test:comments-moderation` for cooldown, filter, pagination and moderation layout
regressions at 320, 390, 768, 1024, 1600 and 2560 pixels. All test writes are intercepted.

Run `npm run test:discussions` for the public discussion list, paging, thread/back navigation,
empty/error states, toolbar labels, light/dark themes and reduced-motion pulse behavior at phone
and desktop sizes. It starts its own Vite server with fixed feed data and intercepted API responses.

Run `npm run test:moderator-gate` for keyboard activation, native Chromium touch swipes and scrolling
at phone sizes, synchronous input focus, cancellation and gesture resets. It starts its own Vite
server and intercepts API requests; no backend is needed. Headless browser checks cannot verify the
OS soft keyboard itself, so its appearance still needs a physical phone check.

Run `npm run test:moderator-scroll` for successful login, password-dialog/sidebar overlap,
moderation-panel scrolling, close/reopen and resize behavior with animations enabled and disabled.
It uses an isolated browser fixture and intercepted login/moderation responses.

Run `npm run test:feed-menu` for full-height comment buttons, centered icons/counts, menu flipping
at viewport edges, scrolling in short windows, resizing, keyboard anchoring and dismissal. This
suite starts its own Vite server and uses fixed feed data and intercepted API responses; no backend
is needed. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can also select the browser for this suite.
