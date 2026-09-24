#!/usr/bin/env node
// End-to-end smoke test against saved copies of YouTube pages.
//
// YouTube requires a signed-in session, so the test cannot use the live site.
// Instead it takes "Webpage, Complete" saves of the subscriptions page and,
// optionally, the Watch Later playlist page (which contain your real markup),
// strips YouTube's scripts, serves them locally together with a fake ytcfg and
// mocked InnerTube endpoints, loads the extension into the installed Chrome,
// and checks the result.
//
//   node test/run.mjs --fixture ~/Downloads/subs.html [--wl-fixture ~/Downloads/later.html]
//                     [--out test/out] [--chrome /usr/bin/google-chrome] [--wl-fail]
//
// The fixtures are never committed: they contain your session tokens.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(expandHome(args.out || path.join(here, 'out')));
const chromePath = args.chrome || '/usr/bin/google-chrome';
const wlFail = Boolean(args['wl-fail']);

if (!args.fixture || !fs.existsSync(path.resolve(expandHome(args.fixture)))) {
  console.error(
    'Usage: node test/run.mjs --fixture <saved subscriptions page.html> [--wl-fixture <saved Watch Later page.html>] [--out dir] [--chrome path] [--wl-fail]'
  );
  process.exit(2);
}
if (args['wl-fixture'] && !fs.existsSync(path.resolve(expandHome(args['wl-fixture'])))) {
  console.error(`Watch Later fixture not found: ${args['wl-fixture']}`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Fixtures: strip scripts, add a fake ytcfg + cookie, add a little layout CSS
// that YouTube normally injects from JavaScript.
// ---------------------------------------------------------------------------

const fixtureCss = `
  ytd-masthead, #masthead-container, ytd-mini-guide-renderer, tp-yt-app-drawer, ytd-guide-renderer,
  ytd-popup-container, ytd-miniplayer, ytd-watch-flexy, ytd-player, ytd-yoodle-renderer,
  ytd-playlist-sidebar-renderer, ytd-playlist-header-renderer, yt-page-header-portal { display: none !important; }
  body { margin: 0; background: #0f0f0f; color: #f1f1f1; }
  ytd-app, ytd-page-manager { display: block; }
  ytd-browse[hidden] { display: none !important; }
  ytd-browse { display: block; max-width: 1440px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
  /* Subscriptions grid (what YouTube's own CSS does). */
  #contents.ytd-rich-grid-renderer { display: flex; flex-wrap: wrap; --ytd-rich-grid-item-margin: 16px; --ytd-rich-grid-row-margin: 40px; }
  ytd-rich-item-renderer { position: relative; margin: 0 8px 40px; width: calc(100% / var(--ytd-rich-grid-items-per-row, 4) - 16px); }
  ytd-rich-section-renderer { width: 100%; display: flex; justify-content: center; }
  #content.ytd-rich-section-renderer { width: 100%; margin: 0 8px; }
  ytd-rich-shelf-renderer #contents { display: flex; gap: 16px; overflow: hidden; }
  h2 { font-size: 2rem; margin: 0 0 12px; }
  /* Playlist rows (what YouTube's own CSS does). */
  ytd-playlist-video-renderer { display: flex; flex-direction: row; align-items: center; }
  #index-container.ytd-playlist-video-renderer { display: flex; align-items: center; width: 40px; flex: none; }
  #content.ytd-playlist-video-renderer { display: flex; flex-direction: row; flex: 1; min-width: 0; padding: 8px 0; }
  #container.ytd-playlist-video-renderer { display: flex; flex: 1; min-width: 0; }
  ytd-thumbnail.ytd-playlist-video-renderer { width: 200px; height: 113px; margin-right: 8px; flex: none; display: block; }
  ytd-thumbnail.ytd-playlist-video-renderer a { display: block; position: relative; width: 100%; height: 100%; }
  ytd-thumbnail.ytd-playlist-video-renderer yt-image { display: block; width: 100%; height: 100%; }
  #meta.ytd-playlist-video-renderer { flex: 1; min-width: 0; }
  #menu.ytd-playlist-video-renderer { min-width: 40px; }
  h3.ytd-playlist-video-renderer { margin: 0 0 4px; font-size: 1.6rem; font-weight: 500; }
  #video-title.ytd-playlist-video-renderer { color: #f1f1f1; text-decoration: none; }
`;

const fixtureScript = `
  window.ytcfg = {
    data_: {
      INNERTUBE_API_KEY: 'FAKE_KEY',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20260922.06.00', hl: 'en' } },
      INNERTUBE_CLIENT_VERSION: '2.20260922.06.00',
      INNERTUBE_CONTEXT_CLIENT_NAME: 1,
      SESSION_INDEX: '0',
      VISITOR_DATA: 'fakeVisitor',
      LOGGED_IN: true,
    },
    get(key, fallback) { return key in this.data_ ? this.data_[key] : fallback; },
  };
  document.cookie = 'SAPISID=fakeSapisid; path=/';
`;

function loadFixture(p) {
  const abs = path.resolve(expandHome(p));
  const raw = fs.readFileSync(abs, 'utf8');
  const html = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<head([^>]*)>/i, `<head$1><script>${fixtureScript}</script><style>${fixtureCss}</style>`);
  return { path: abs, dir: path.dirname(abs), name: path.basename(abs), raw, html };
}

const subsFixture = loadFixture(args.fixture);
const wlFixture = args['wl-fixture'] ? loadFixture(args['wl-fixture']) : null;
const fixtures = [subsFixture, wlFixture].filter(Boolean);

const feedIds = [...subsFixture.raw.matchAll(/content-id-([A-Za-z0-9_-]{11})/g)].map((m) => m[1]);
const uniqueIds = [...new Set(feedIds)];
if (uniqueIds.length < 12) {
  console.error(`Subscriptions fixture only has ${uniqueIds.length} video ids; expected a full feed.`);
  process.exit(2);
}
const WL_PAGE1 = [uniqueIds[3], uniqueIds[7], uniqueIds[8]];
const WL_PAGE2 = [uniqueIds[10]];
const WL_ALL = new Set([...WL_PAGE1, ...WL_PAGE2]);

// ---------------------------------------------------------------------------
// Local server: static files from the fixture directories + mocked InnerTube.
// ---------------------------------------------------------------------------

const requests = { browse: [], edit: [] };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function mimeFor(filePath) {
  const base = path.basename(filePath);
  if (/^css(\(\d+\))?$/.test(base) || base === 'css2' || base.startsWith('rs=')) return 'text/css';
  return MIME[path.extname(base).toLowerCase()] || 'application/octet-stream';
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function playlistVideo(id) {
  return { playlistVideoRenderer: { videoId: id, title: { runs: [{ text: id }] } } };
}

function lockupVideo(id) {
  return { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } };
}

function wlResponse(body) {
  if (body.browseId === 'VLWL') {
    return {
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{
            playlistVideoListRenderer: {
              contents: [
                ...WL_PAGE1.map(playlistVideo),
                { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'PAGE2', request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } } },
              ],
            },
          }] } }] } } } }],
        },
      },
      // Decoys that must NOT be counted as Watch Later videos.
      sidebar: { items: [lockupVideo('decoy00000A')] },
      header: { items: [playlistVideo('decoy00000B')] },
    };
  }
  if (body.continuation === 'PAGE2') {
    return {
      onResponseReceivedActions: [{ appendContinuationItemsAction: {
        continuationItems: [
          ...WL_PAGE2.map(lockupVideo),
          { continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token: 'PAGE3', request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } } } },
        ],
      } }],
    };
  }
  // PAGE3: an empty page ends pagination.
  return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [] } }] };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname.startsWith('/youtubei/v1/')) {
    const body = JSON.parse((await readBody(req)) || '{}');
    const entry = { path: url.pathname, headers: req.headers, body };
    const isBrowse = url.pathname === '/youtubei/v1/browse';
    const isEdit = url.pathname === '/youtubei/v1/browse/edit_playlist';
    if (isBrowse) requests.browse.push(entry);
    if (isEdit) requests.edit.push(entry);
    if (!isBrowse && !isEdit) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (wlFail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"mock failure"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(isBrowse ? wlResponse(body) : { status: 'STATUS_SUCCEEDED' }));
    return;
  }

  const pathname = decodeURIComponent(url.pathname);
  const fixture = fixtures.find((f) => pathname === `/${f.name}`);
  if (fixture) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture.html);
    return;
  }
  for (const dir of new Set(fixtures.map((f) => f.dir))) {
    const filePath = path.join(dir, pathname);
    if (filePath.startsWith(dir) && fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      res.writeHead(200, { 'Content-Type': mimeFor(filePath) });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const urlFor = (fixture) => `http://127.0.0.1:${port}/${fixture.name}`;

// ---------------------------------------------------------------------------
// Extension copy with the local origin added to the content script matches.
// ---------------------------------------------------------------------------

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-subs-list-ext-'));
for (const entry of ['manifest.json', 'src', 'popup', 'icons']) {
  fs.cpSync(path.join(repoRoot, entry), path.join(extDir, entry), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
for (const script of manifest.content_scripts) script.matches.push('http://127.0.0.1/*');
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---------------------------------------------------------------------------
// Drive Chrome.
// ---------------------------------------------------------------------------

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  (ok ? passes : failures).push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Current Chrome builds ignore --load-extension; Puppeteer's enableExtensions
// installs the unpacked extension through the DevTools protocol instead.
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  enableExtensions: [extDir],
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1600,1200'],
  defaultViewport: { width: 1600, height: 1200 },
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await testSubscriptionsPage(page);
  if (wlFixture) await testWatchLaterPage(page);

  const ownErrors = consoleErrors.filter((e) => e.includes('yt-subs-list'));
  check('no extension errors in console', ownErrors.length === 0, ownErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
}

console.log(`\n${passes.length} passed, ${failures.length} failed. Screenshots in ${outDir}`);
process.exit(failures.length ? 1 : 0);

// ---------------------------------------------------------------------------

async function testSubscriptionsPage(page) {
  console.log(`\n== Subscriptions page (${subsFixture.name}) ==`);
  await page.goto(urlFor(subsFixture), { waitUntil: 'load', timeout: 60000 });

  const wlSettled = await page
    .waitForFunction(
      () => window.__ytSubsList && ['ready', 'error'].includes(window.__ytSubsList.wl.status),
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  check('Watch Later fetch settled', wlSettled);
  await sleep(300);

  const snapshot = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const browse = document.querySelector('ytd-browse[page-subtype="subscriptions"]');
    const contents = browse.querySelector('ytd-rich-grid-renderer > #contents');
    const contentsWidth = contents.getBoundingClientRect().width;
    const sections = [...browse.querySelectorAll('ytd-rich-grid-renderer > #contents > ytd-rich-section-renderer')].map((s) => ({
      title: (s.querySelector('#title, h2') || {}).textContent?.trim() || '',
      shelf: Boolean(s.querySelector('ytd-rich-shelf-renderer')),
      shorts: Boolean(s.querySelector('ytd-rich-shelf-renderer[is-shorts]')),
      visible: visible(s),
      hiddenReason: s.getAttribute('data-ysl-hidden'),
    }));
    const items = [...browse.querySelectorAll('ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer')].map((item) => {
      const thumb = item.querySelector('a.ytLockupViewModelContentImage');
      const title = item.querySelector('.ytLockupMetadataViewModelTitle');
      const wrap = item.querySelector('.ysl-wl');
      const r = item.getBoundingClientRect();
      return {
        id: wrap?.dataset.vid || null,
        visible: visible(item),
        width: r.width,
        thumbRight: thumb ? thumb.getBoundingClientRect().right : null,
        thumbWidth: thumb ? thumb.getBoundingClientRect().width : null,
        titleLeft: title ? title.getBoundingClientRect().left : null,
        wlState: wrap ? wrap.firstElementChild.dataset.state : null,
        wlRight: wrap ? wrap.getBoundingClientRect().right : null,
        wlLeft: wrap ? wrap.getBoundingClientRect().left : null,
      };
    });
    return {
      contentsWidth,
      sections,
      items,
      thumbVar: getComputedStyle(document.documentElement).getPropertyValue('--ysl-thumb-width').trim(),
      htmlFlags: { ...document.documentElement.dataset },
      wlStatus: window.__ytSubsList.wl.status,
      wlCount: window.__ytSubsList.wl.ids.size,
    };
  });

  fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));

  check('settings mirrored onto <html>', snapshot.htmlFlags.ysl === 'on', JSON.stringify(snapshot.htmlFlags));
  const latest = snapshot.sections.find((s) => /latest/i.test(s.title));
  check('"Latest" header kept', Boolean(latest && latest.visible));
  const mostRelevant = snapshot.sections.find((s) => /most relevant/i.test(s.title));
  check('"Most relevant" shelf hidden', Boolean(mostRelevant) && !mostRelevant.visible, mostRelevant ? `reason=${mostRelevant.hiddenReason}` : 'not present in fixture');
  const shorts = snapshot.sections.filter((s) => s.shorts);
  check('Shorts shelf hidden', shorts.length > 0 && shorts.every((s) => !s.visible), `${shorts.length} shelf(s)`);
  check('no visible shelves remain', snapshot.sections.filter((s) => s.shelf && s.visible).length === 0);

  const visibleItems = snapshot.items.filter((i) => i.visible);
  check('feed items present', visibleItems.length >= 20, `${visibleItems.length} visible`);
  const fullWidth = visibleItems.filter((i) => i.width >= snapshot.contentsWidth * 0.9);
  check('every row spans the feed width', fullWidth.length === visibleItems.length, `${fullWidth.length}/${visibleItems.length}`);
  const rowLayout = visibleItems.filter((i) => i.thumbRight !== null && i.titleLeft !== null && i.thumbRight <= i.titleLeft + 1);
  check('thumbnail sits left of the title', rowLayout.length === visibleItems.length, `${rowLayout.length}/${visibleItems.length}`);
  const thumbPx = parseFloat(snapshot.thumbVar);
  const thumbSized = visibleItems.filter((i) => Math.abs(i.thumbWidth - thumbPx) < 2);
  check('thumbnail width follows the setting', thumbSized.length === visibleItems.length, `${thumbPx}px, ${thumbSized.length}/${visibleItems.length}`);
  const withButtons = visibleItems.filter((i) => i.wlState);
  check('every row has a Watch Later button', withButtons.length === visibleItems.length, `${withButtons.length}/${visibleItems.length}`);
  const buttonPlaced = withButtons.filter((i) => i.wlLeft >= i.thumbRight - 1 && i.wlRight <= i.titleLeft + 1);
  check('button sits between thumbnail and title', buttonPlaced.length === withButtons.length, `${buttonPlaced.length}/${withButtons.length}`);

  if (wlFail) {
    check('Watch Later status is error', snapshot.wlStatus === 'error', snapshot.wlStatus);
    check('buttons fall back to unknown state', withButtons.every((i) => i.wlState === 'unknown'));
  } else {
    check('Watch Later status is ready', snapshot.wlStatus === 'ready', snapshot.wlStatus);
    check('Watch Later ids collected from both pages, decoys ignored', snapshot.wlCount === WL_ALL.size, `${snapshot.wlCount} vs ${WL_ALL.size}`);
    const expectedIn = withButtons.filter((i) => WL_ALL.has(i.id));
    check('videos in Watch Later show "in"', expectedIn.length > 0 && expectedIn.every((i) => i.wlState === 'in'), `${expectedIn.length} rows`);
    const expectedOut = withButtons.filter((i) => !WL_ALL.has(i.id));
    check('other videos show "out"', expectedOut.every((i) => i.wlState === 'out'), `${expectedOut.length} rows`);
    const browseReq = requests.browse[0];
    check('browse request carries SAPISIDHASH auth', Boolean(browseReq && /^SAPISIDHASH \d+_[0-9a-f]{40}/.test(browseReq.headers.authorization || '')));
    check('browse request carries account headers', Boolean(browseReq && browseReq.headers['x-goog-authuser'] === '0' && browseReq.headers['x-origin']));
    check('browse request has context', Boolean(browseReq && browseReq.body.context && browseReq.body.context.client));
  }

  await page.screenshot({ path: path.join(outDir, 'subs.png') });
  const firstOut = withButtons.find((i) => i.wlState === 'out') || withButtons[0];

  // Toggle: click an "out" button, expect an ADD, then click again for a REMOVE.
  if (!wlFail && firstOut) {
    const sel = `.ysl-wl[data-vid="${firstOut.id}"] .ysl-wl-btn`;
    const startUrl = page.url();
    await page.click(sel);
    await page.waitForFunction((s) => document.querySelector(s).dataset.state === 'in', { timeout: 5000 }, sel).catch(() => {});
    let state = await page.$eval(sel, (b) => b.dataset.state);
    const add = requests.edit.at(-1);
    check('click adds to Watch Later', state === 'in' && add && add.body.playlistId === 'WL' && add.body.actions[0].action === 'ACTION_ADD_VIDEO' && add.body.actions[0].addedVideoId === firstOut.id, `state=${state}`);
    check('click did not navigate', page.url() === startUrl);
    await page.click(sel);
    await page.waitForFunction((s) => document.querySelector(s).dataset.state === 'out', { timeout: 5000 }, sel).catch(() => {});
    state = await page.$eval(sel, (b) => b.dataset.state);
    const remove = requests.edit.at(-1);
    check('second click removes from Watch Later', state === 'out' && remove && remove.body.actions[0].action === 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID' && remove.body.actions[0].removedVideoId === firstOut.id, `state=${state}`);
    check('label reflects state', await page.$eval(sel, (b) => b.nextElementSibling.textContent) === 'Watch later');
  }

  // Disable via the settings attribute (what content.js does when toggled off).
  await page.evaluate(() => { document.documentElement.dataset.ysl = 'off'; });
  await sleep(300);
  const disabled = await page.evaluate(() => ({
    buttons: document.querySelectorAll('.ysl-wl').length,
    hidden: document.querySelectorAll('[data-ysl-hidden]').length,
    shelfVisible: getComputedStyle(document.querySelector('ytd-rich-shelf-renderer[is-shorts]').closest('ytd-rich-section-renderer')).display !== 'none',
  }));
  check('disabling removes buttons and unhides shelves', disabled.buttons === 0 && disabled.hidden === 0 && disabled.shelfVisible, JSON.stringify(disabled));
  await page.screenshot({ path: path.join(outDir, 'subs-disabled.png') });

  await page.evaluate(() => { document.documentElement.dataset.ysl = 'on'; });
  await sleep(300);
  const reenabled = await page.evaluate(() => document.querySelectorAll('.ysl-wl').length);
  check('re-enabling restores buttons', reenabled === withButtons.length, `${reenabled}`);
}

async function testWatchLaterPage(page) {
  console.log(`\n== Watch Later page (${wlFixture.name}) ==`);
  const browseBefore = requests.browse.length;
  const wlUrl = urlFor(wlFixture);
  await page.goto(wlUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.ysl-rm').length > 0, { timeout: 10000 }).catch(() => {});
  await sleep(300);

  const rows = await page.evaluate(() => {
    const visible = (el) => el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    const browse = document.querySelector('ytd-browse[page-subtype="playlist"]');
    return [...browse.querySelectorAll('ytd-playlist-video-renderer')].map((row) => {
      const link = row.querySelector('a#video-title');
      const wrap = row.querySelector('.ysl-rm');
      const menu = row.querySelector('#menu');
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      return {
        id: wrap?.dataset.vid || null,
        href: link?.getAttribute('href') || '',
        visible: visible(row),
        state: wrap?.firstElementChild.dataset.state || null,
        btnLeft: rect(wrap)?.left,
        btnRight: rect(wrap)?.right,
        titleRight: rect(link)?.right,
        menuLeft: rect(menu)?.left,
      };
    });
  });
  fs.writeFileSync(path.join(outDir, 'wl-snapshot.json'), JSON.stringify(rows, null, 2));

  const visibleRows = rows.filter((r) => r.visible);
  check('Watch Later rows present', visibleRows.length >= 10, `${visibleRows.length} rows`);
  check('every row links to the Watch Later list', visibleRows.every((r) => /[?&]list=WL(&|$)/.test(r.href)));
  const withButtons = visibleRows.filter((r) => r.state);
  check('every row has a remove button', withButtons.length === visibleRows.length, `${withButtons.length}/${visibleRows.length}`);
  check('button id matches the row link', withButtons.every((r) => r.href.includes(`v=${r.id}`)));
  const placed = withButtons.filter((r) => r.btnLeft >= r.titleRight - 1 && r.btnRight <= r.menuLeft + 1);
  check('button sits between the title and the menu', placed.length === withButtons.length, `${placed.length}/${withButtons.length}`);
  check('no playlist fetch on the Watch Later page', requests.browse.length === browseBefore);
  await page.screenshot({ path: path.join(outDir, 'wl.png') });

  const target = withButtons[0];
  if (!target) return;
  const sel = `.ysl-rm[data-vid="${target.id}"] .ysl-rm-btn`;
  const editsBefore = requests.edit.length;
  await page.click(sel);
  await page
    .waitForFunction((s) => document.querySelector(s).dataset.state !== 'busy', { timeout: 5000 }, sel)
    .catch(() => {});
  await sleep(100);
  const after = await page.evaluate((s) => {
    const btn = document.querySelector(s);
    const row = btn.closest('ytd-playlist-video-renderer');
    return { state: btn.dataset.state, removedAttr: row.hasAttribute('data-ysl-removed'), display: getComputedStyle(row).display, error: btn.parentElement.dataset.error || null };
  }, sel);
  const req = requests.edit.at(-1);
  const sentRemove = requests.edit.length === editsBefore + 1 && req && req.body.playlistId === 'WL' && req.body.actions[0].action === 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID' && req.body.actions[0].removedVideoId === target.id;
  check('click sends a remove request for that video', sentRemove);
  check('click did not navigate', page.url() === wlUrl);
  if (wlFail) {
    check('failed removal keeps the row and flags the button', !after.removedAttr && after.display !== 'none' && after.error === '1', JSON.stringify(after));
  } else {
    check('removed row disappears', after.removedAttr && after.display === 'none', JSON.stringify(after));
    const remaining = await page.evaluate(() => [...document.querySelectorAll('ytd-playlist-video-renderer')].filter((r) => getComputedStyle(r).display !== 'none').length);
    check('other rows stay', remaining === visibleRows.length - 1, `${remaining}`);
  }
  await page.screenshot({ path: path.join(outDir, 'wl-after.png') });

  // Setting off: buttons go away.
  await page.evaluate(() => { document.documentElement.dataset.yslWlRemove = 'off'; });
  await sleep(300);
  const hiddenCount = await page.evaluate(() => [...document.querySelectorAll('.ysl-rm')].filter((el) => getComputedStyle(el).display !== 'none').length);
  check('turning the setting off hides the buttons', hiddenCount === 0, `${hiddenCount} visible`);
  await page.evaluate(() => { document.documentElement.dataset.yslWlRemove = 'on'; });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}
