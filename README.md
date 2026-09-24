# YouTube Subscriptions & Watch Later

A Chrome extension that makes the YouTube subscriptions feed look the way it used to, and makes Watch Later
quicker to manage:

- **No Shorts, no "Most relevant"**: the Shorts shelf, the "Most relevant" shelf and any other shelf-style
  block are removed, leaving only the chronological feed under the "Latest" header.
- **A list instead of a grid**: each video is a full-width row with the thumbnail on the left and the title,
  channel, view count and upload age on the right. Duration badges and watched-progress bars are kept.
- **Watch Later at a glance**: every row has a button next to the thumbnail that shows whether the video is
  already in your Watch Later playlist, and adds or removes it with one click.
- **One-click removal on the Watch Later page**: each row on `/playlist?list=WL` gets a trash button next to
  the three-dot menu, so removing a video no longer takes two clicks through the menu.

Everything else on YouTube is left alone. The extension only touches `/feed/subscriptions` and the Watch
Later playlist page.

## Install

1. Clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode** and click **Load unpacked**.
3. Pick the repository folder (the one containing `manifest.json`).
4. Open <https://www.youtube.com/feed/subscriptions>.

After pulling changes, click the reload icon on the extension's card in `chrome://extensions`.

## Settings

Click the extension's toolbar icon. "Enabled" at the top is the master switch; turning it off restores
YouTube's own layout without a reload. The rest is grouped by page:

| Section | Setting | Default | Effect |
| --- | --- | --- | --- |
| Subscriptions feed | Hide Shorts | on | Hides the Shorts shelf and any individual Shorts in the feed. |
| Subscriptions feed | Hide "Most relevant" and other shelves | on | Hides every shelf-style section except the "Latest" header. |
| Subscriptions feed | Watch Later button next to each thumbnail | on | Adds the add/remove button and the "Saved" indicator to each row. |
| Subscriptions feed | Thumbnail width | 240px | Row height follows the thumbnail. |
| Watch Later page | Remove button on each video | on | Adds the trash button next to each row's menu. |
| Debugging | Log details to the console | off | Prints which sections were hidden or kept, and Watch Later activity, to the page console. |

Settings sync through your Chrome profile and apply to open tabs immediately.

## How it works

YouTube is a single-page app that renders without shadow DOM, so the extension restyles YouTube's own
markup rather than re-implementing the feed. That keeps infinite scroll, hover previews, the right-click
and three-dot menus, and everything else YouTube does.

- `src/styles.css` turns the grid into rows. Every rule is gated on `html[data-ysl="on"]` and scoped to
  `ytd-browse[page-subtype="subscriptions"]`.
- `src/content.js` (isolated world) mirrors the settings from `chrome.storage.sync` onto `<html>` as
  data-attributes and a `--ysl-thumb-width` CSS variable.
- `src/page.js` (main world) watches the DOM, tags shelves to hide, inserts the Watch Later button into each
  row, and talks to YouTube's internal API.

### Watch Later

YouTube's feed does not say which videos are already in Watch Later, so on each visit to the subscriptions
page the extension fetches the Watch Later playlist through the same internal `youtubei/v1/browse` endpoint
the YouTube web app uses, following continuation pages (up to 4,000 videos), and caches the result for two
minutes. Adding and removing uses `youtubei/v1/browse/edit_playlist`, the exact call YouTube makes when you
click "Save to Watch later". Requests are signed the way YouTube signs its own (a `SAPISIDHASH` built from
your existing session cookie), so nothing new is stored and nothing leaves your browser except requests to
`www.youtube.com`.

If the playlist cannot be loaded, the buttons dim and fall back to the hint YouTube embeds in the feed data;
clicking still works.

On the Watch Later page the trash button sends the same removal YouTube's own "Remove from Watch later" menu
item sends (by playlist entry id when YouTube exposes it, otherwise by video id) and hides the row on success.
YouTube's "N videos" count in the header is not updated until the page is reloaded.

## Testing

YouTube requires a signed-in session, so the automated test runs against a saved copy of your own
subscriptions page instead of the live site:

1. In Chrome, open the subscriptions page and save it with **Ctrl+S → "Webpage, Complete"**
   (for example to `~/Downloads/subs.html`). Optionally do the same for the Watch Later page
   (`~/Downloads/later.html`). Never commit those files: they contain your session tokens.
2. `npm install`
3. `npm test -- --fixture ~/Downloads/subs.html --wl-fixture ~/Downloads/later.html`

The harness strips YouTube's scripts from the saved pages, serves them locally with a fake `ytcfg` and mocked
`youtubei` endpoints, loads the extension into your installed Chrome in headless mode, and checks that the
shelves are hidden, rows are laid out as thumbnail-left / title-right, Watch Later state is read from both
playlist pages, clicking a feed button sends the right add/remove request, and clicking a trash button on the
Watch Later page sends a removal and hides the row. Screenshots land in `test/out/`. Add `--wl-fail` to
exercise the API-unavailable paths.

## When YouTube changes its markup

The selectors live at the top of `src/page.js` and in `src/styles.css`. Turn on console logging in the
popup: the page console (`F12` on the subscriptions page) then lists every section the extension hid or
kept, which is usually enough to see what changed. `window.__ytSubsList` exposes the live state.
