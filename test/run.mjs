#!/usr/bin/env node
// End-to-end smoke test against a saved copy of the subscriptions page.
//
// YouTube requires a signed-in session, so the test cannot use the live site.
// Instead it takes a "Webpage, Complete" save of https://www.youtube.com/feed/subscriptions
// (which contains your real feed markup), strips YouTube's scripts, serves it
// locally together with a fake ytcfg and mocked InnerTube endpoints, loads the
// extension into the installed Chrome, and checks the result.
//
//   node test/run.mjs --fixture ~/Downloads/subs.html [--out test/out] [--chrome /usr/bin/google-chrome] [--wl-fail]
//
// The fixture is never committed: it contains your session tokens and feed.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = parseArgs(process.argv.slice(2));
const fixturePath = path.resolve(expandHome(args.fixture || ''));
const outDir = path.resolve(expandHome(args.out || path.join(here, 'out')));
const chromePath = args.chrome || '/usr/bin/google-chrome';
const wlFail = Boolean(args['wl-fail']);

if (!args.fixture || !fs.existsSync(fixturePath)) {
  console.error('Usage: node test/run.mjs --fixture <saved subscriptions page.html> [--out dir] [--chrome path] [--wl-fail]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Fixture: strip scripts, add a fake ytcfg + cookie, add a little layout CSS
// that YouTube normally injects from JavaScript.
// ---------------------------------------------------------------------------

const rawHtml = fs.readFileSync(fixturePath, 'utf8');
const feedIds = [...rawHtml.matchAll(/content-id-([A-Za-z0-9_-]{11})/g)].map((m) => m[1]);
const uniqueIds = [...new Set(feedIds)];
if (uniqueIds.length < 12) {
  console.error(`Fixture only has ${uniqueIds.length} video ids; expected a full feed.`);
  process.exit(2);
}
const WL_PAGE1 = [uniqueIds[3], uniqueIds[7], uniqueIds[8]];
const WL_PAGE2 = [uniqueIds[10]];
const WL_ALL = new Set([...WL_PAGE1, ...WL_PAGE2]);

const fixtureCss = `
  ytd-masthead, #masthead-container, ytd-mini-guide-renderer, tp-yt-app-drawer, ytd-guide-renderer,
  ytd-popup-container, ytd-miniplayer, ytd-watch-flexy, ytd-player, ytd-yoodle-renderer { display: none !important; }
  body { margin: 0; background: #0f0f0f; color: #f1f1f1; }
  ytd-app, ytd-page-manager { display: block; }
  ytd-browse[hidden] { display: none !important; }
  ytd-browse { display: block; max-width: 1440px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
  #contents.ytd-rich-grid-renderer { display: flex; flex-wrap: wrap; --ytd-rich-grid-item-margin: 16px; --ytd-rich-grid-row-margin: 40px; }
  ytd-rich-item-renderer { position: relative; margin: 0 8px 40px; width: calc(100% / var(--ytd-rich-grid-items-per-row, 4) - 16px); }
  ytd-rich-section-renderer { width: 100%; display: flex; justify-content: center; }
  #content.ytd-rich-section-renderer { width: 100%; margin: 0 8px; }
  ytd-rich-shelf-renderer #contents { display: flex; gap: 16px; overflow: hidden; }
  h2 { font-size: 2rem; margin: 0 0 12px; }
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

const fixtureHtml = rawHtml
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
  .replace(/<head([^>]*)>/i, `<head$1><script>${fixtureScript}</script><style>${fixtureCss}</style>`);

// ---------------------------------------------------------------------------
// Local server: static files from the fixture directory + mocked InnerTube.
// ---------------------------------------------------------------------------

const fixtureDir = path.dirname(fixturePath);
const fixtureName = path.basename(fixturePath);
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
    if (url.pathname === '/youtubei/v1/browse') {
      requests.browse.push(entry);
      if (wlFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"mock failure"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wlResponse(body)));
      return;
    }
    if (url.pathname === '/youtubei/v1/browse/edit_playlist') {
      requests.edit.push(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'STATUS_SUCCEEDED' }));
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === `/${fixtureName}`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
    return;
  }
  const filePath = path.join(fixtureDir, pathname);
  if (!filePath.startsWith(fixtureDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': mimeFor(filePath) });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const fixtureUrl = `http://127.0.0.1:${port}/${fixtureName}`;

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

  await page.goto(fixtureUrl, { waitUntil: 'load', timeout: 60000 });

  const wlSettled = await page
    .waitForFunction(
      () => window.__ytSubsList && ['ready', 'error'].includes(window.__ytSubsList.wl.status),
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  check('Watch Later fetch settled', wlSettled);
  await new Promise((r) => setTimeout(r, 300));

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

  await page.screenshot({ path: path.join(outDir, 'top.png') });
  const firstOut = withButtons.find((i) => i.wlState === 'out') || withButtons[0];
  if (firstOut) {
    await page.evaluate((id) => {
      document.querySelector(`.ysl-wl[data-vid="${id}"]`).scrollIntoView({ block: 'center' });
    }, firstOut.id);
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(outDir, 'rows.png') });
  }

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
  await new Promise((r) => setTimeout(r, 300));
  const disabled = await page.evaluate(() => ({
    buttons: document.querySelectorAll('.ysl-wl').length,
    hidden: document.querySelectorAll('[data-ysl-hidden]').length,
    shelfVisible: getComputedStyle(document.querySelector('ytd-rich-shelf-renderer[is-shorts]').closest('ytd-rich-section-renderer')).display !== 'none',
  }));
  check('disabling removes buttons and unhides shelves', disabled.buttons === 0 && disabled.hidden === 0 && disabled.shelfVisible, JSON.stringify(disabled));
  await page.screenshot({ path: path.join(outDir, 'disabled.png') });

  await page.evaluate(() => { document.documentElement.dataset.ysl = 'on'; });
  await new Promise((r) => setTimeout(r, 300));
  const reenabled = await page.evaluate(() => document.querySelectorAll('.ysl-wl').length);
  check('re-enabling restores buttons', reenabled === withButtons.length, `${reenabled}`);

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
