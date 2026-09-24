// Main-world content script.
//
// Runs inside the page's own JavaScript world (manifest "world": "MAIN") so it
// can read YouTube's `ytcfg` (API key, client context, account index) and the
// data YouTube attaches to its Polymer elements. It has no access to chrome.*
// APIs; settings arrive as data-attributes on <html>, written by content.js.
//
// Responsibilities:
//   1. Hide the Shorts shelf, the "Most relevant" shelf and similar sections.
//   2. Tag each feed item with its video id so styles.css can lay it out as a row.
//   3. Add a Watch Later indicator/toggle next to every thumbnail, backed by the
//      Watch Later playlist fetched through YouTube's internal API.
//   4. On the Watch Later playlist page, add a one-click remove button to each row.
(() => {
  'use strict';

  if (window.__ytSubsList) return;

  const TAG = '[yt-subs-list]';
  const WL_TTL_MS = 2 * 60 * 1000;
  const WL_RETRY_MS = 60 * 1000;
  const WL_MAX_PAGES = 40;

  const SUBS_BROWSE = 'ytd-browse[page-subtype="subscriptions"]';
  const FEED_ITEMS = 'ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer';
  const FEED_SECTIONS = 'ytd-rich-grid-renderer > #contents > ytd-rich-section-renderer';
  const SHORTS_SHELF = 'ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer';
  const OTHER_SHELF = [
    'ytd-rich-shelf-renderer',
    'ytd-reel-shelf-renderer',
    'grid-shelf-view-model',
    'ytd-horizontal-card-list-renderer',
    'ytd-post-renderer',
    'ytd-inline-survey-renderer',
    'ytd-statement-banner-renderer',
    'ytd-brand-video-shelf-renderer',
    'ytd-ad-slot-renderer',
  ].join(', ');
  const THUMB_ANCHOR = 'a.ytLockupViewModelContentImage, ytd-thumbnail';
  const VIDEO_LINK = 'a[href*="/watch?"], a[href*="/shorts/"]';

  // Watch Later playlist page (/playlist?list=WL).
  const PLAYLIST_BROWSE = 'ytd-browse[page-subtype="playlist"]';
  const PLAYLIST_ROWS = 'ytd-playlist-video-renderer';
  const PLAYLIST_ROW_LINK = 'a#video-title[href], ytd-thumbnail a[href]';
  const WATCH_LATER_LIST = /[?&]list=WL(?:&|$)/;

  const root = document.documentElement;
  const settings = {
    enabled: true,
    hideShorts: true,
    hideShelves: true,
    watchLater: true,
    wlRemove: true,
    debug: false,
  };

  function readSettings() {
    const d = root.dataset;
    settings.enabled = d.ysl !== 'off';
    settings.hideShorts = d.yslHideShorts !== 'off';
    settings.hideShelves = d.yslHideShelves !== 'off';
    settings.watchLater = d.yslWatchLater !== 'off';
    settings.wlRemove = d.yslWlRemove !== 'off';
    settings.debug = d.yslDebug === 'on';
  }

  const log = (...args) => settings.debug && console.log(TAG, ...args);
  const warn = (...args) => console.warn(TAG, ...args);

  // ---------------------------------------------------------------------------
  // Watch Later state
  // ---------------------------------------------------------------------------

  const wl = {
    ids: new Set(),
    status: 'idle', // idle | loading | ready | error
    fetchedAt: 0,
    nextRetryAt: 0,
    promise: null,
    // Results of toggles made by the user, applied on top of whatever the
    // playlist fetch returns so a fetch that was already in flight cannot undo
    // a click.
    overrides: new Map(),
  };

  function cfg(key, fallback) {
    try {
      const value = window.ytcfg && window.ytcfg.get ? window.ytcfg.get(key) : undefined;
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function cookie(name) {
    const escaped = name.replace(/[-_.]/g, '\\$&');
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function sha1Hex(text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // The same Authorization header YouTube's own client sends: a SHA-1 over the
  // timestamp, the SAPISID cookie and the origin.
  async function authorizationHeader() {
    const origin = location.origin;
    const ts = Math.floor(Date.now() / 1000);
    const variants = [
      ['SAPISIDHASH', cookie('SAPISID') || cookie('__Secure-3PAPISID')],
      ['SAPISID1PHASH', cookie('__Secure-1PAPISID')],
      ['SAPISID3PHASH', cookie('__Secure-3PAPISID')],
    ];
    const parts = [];
    for (const [label, value] of variants) {
      if (value) parts.push(`${label} ${ts}_${await sha1Hex(`${ts} ${value} ${origin}`)}`);
    }
    return parts.length ? parts.join(' ') : null;
  }

  async function innertube(endpoint, body) {
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('ytcfg.INNERTUBE_CONTEXT is not available');

    const url = new URL(`/youtubei/v1/${endpoint}`, location.origin);
    url.searchParams.set('prettyPrint', 'false');
    const apiKey = cfg('INNERTUBE_API_KEY');
    if (apiKey) url.searchParams.set('key', apiKey);

    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX', 0)),
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME', 1)),
      'X-Youtube-Client-Version': String(
        cfg('INNERTUBE_CLIENT_VERSION', (context.client && context.client.clientVersion) || '')
      ),
    };
    const auth = await authorizationHeader();
    if (auth) headers.Authorization = auth;
    const pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId;
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;

    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
    return response.json();
  }

  function walk(node, visit, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit, depth + 1);
      return;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      visit(key, value);
      walk(value, visit, depth + 1);
    }
  }

  function responseRoots(res) {
    return [res.contents, res.onResponseReceivedActions, res.onResponseReceivedEndpoints].filter(Boolean);
  }

  function collectVideoIds(res, into) {
    let count = 0;
    walk(responseRoots(res), (key, value) => {
      if (!value || typeof value !== 'object') return;
      let id = null;
      if (key === 'playlistVideoRenderer' || key === 'playlistPanelVideoRenderer') id = value.videoId;
      else if (key === 'lockupViewModel' && (!value.contentType || value.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
        id = value.contentId;
      }
      if (typeof id === 'string' && id) {
        into.add(id);
        count++;
      }
    });
    return count;
  }

  function findContinuation(res) {
    let token = null;
    walk(responseRoots(res), (key, value) => {
      if (token || !value || typeof value !== 'object') return;
      if (key !== 'continuationItemRenderer' && key !== 'continuationItemViewModel') return;
      walk(value, (innerKey, innerValue) => {
        if (!token && innerKey === 'continuationCommand' && innerValue && typeof innerValue.token === 'string') {
          token = innerValue.token;
        }
      });
    });
    return token;
  }

  function refreshWatchLater(force) {
    if (wl.promise) return wl.promise;
    const now = Date.now();
    if (!force) {
      if (wl.status === 'ready' && now - wl.fetchedAt < WL_TTL_MS) return Promise.resolve();
      if (wl.status === 'error' && now < wl.nextRetryAt) return Promise.resolve();
    }

    wl.status = wl.status === 'ready' ? 'ready' : 'loading';
    updateAllButtons();

    wl.promise = (async () => {
      const ids = new Set();
      const seenTokens = new Set();
      let res = await innertube('browse', { browseId: 'VLWL' });
      let pages = 1;
      let token = findContinuation(res);
      collectVideoIds(res, ids);
      while (token && pages < WL_MAX_PAGES && !seenTokens.has(token)) {
        seenTokens.add(token);
        res = await innertube('browse', { continuation: token });
        pages++;
        if (collectVideoIds(res, ids) === 0) break;
        token = findContinuation(res);
      }
      for (const [id, inList] of wl.overrides) {
        if (inList) ids.add(id);
        else ids.delete(id);
      }
      wl.overrides.clear();
      wl.ids = ids;
      wl.status = 'ready';
      wl.fetchedAt = Date.now();
      log(`Watch Later: ${ids.size} video(s) across ${pages} page(s)`);
    })()
      .catch((err) => {
        wl.status = 'error';
        wl.nextRetryAt = Date.now() + WL_RETRY_MS;
        warn('Could not load the Watch Later playlist:', err);
      })
      .finally(() => {
        wl.promise = null;
        updateAllButtons();
      });
    return wl.promise;
  }

  async function editWatchLater(videoId, operation) {
    const actions =
      operation === 'add'
        ? [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }]
        : [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }];
    const res = await innertube('browse/edit_playlist', { playlistId: 'WL', actions });
    if (res && res.status && res.status !== 'STATUS_SUCCEEDED') {
      throw new Error(`edit_playlist returned ${res.status}`);
    }
    return res;
  }

  // YouTube's feed data carries an isToggled flag on the hover "Watch later"
  // button. Used as a hint until the playlist itself has been fetched.
  function hintFromItemData(item) {
    try {
      const data = item.data || (item.__data && item.__data.data);
      const lockup = data && data.content && data.content.lockupViewModel;
      const overlays =
        (lockup && lockup.contentImage && lockup.contentImage.thumbnailViewModel &&
          lockup.contentImage.thumbnailViewModel.overlays) || [];
      for (const overlay of overlays) {
        const buttons = (overlay.thumbnailHoverOverlayToggleActionsViewModel || {}).buttons || [];
        for (const button of buttons) {
          const toggle = button.toggleButtonViewModel;
          const icon = toggle && toggle.defaultButtonViewModel && toggle.defaultButtonViewModel.buttonViewModel &&
            toggle.defaultButtonViewModel.buttonViewModel.iconName;
          if (icon === 'WATCH_LATER') return Boolean(toggle.isToggled);
        }
      }
    } catch {
      /* ignore: data shape changed */
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Watch Later button
  // ---------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_CLOCK =
    'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z';
  const ICON_CHECK = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
  const ICON_TRASH = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5-1-1h-5l-1 1H5v2h14V4z';

  function svgIcon(className, pathData) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    return svg;
  }

  function buildButton(videoId) {
    const wrap = document.createElement('div');
    wrap.className = 'ysl-wl';
    wrap.dataset.vid = videoId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ysl-btn ysl-wl-btn';
    button.appendChild(svgIcon('ysl-icon-clock', ICON_CLOCK));
    button.appendChild(svgIcon('ysl-icon-check', ICON_CHECK));
    const label = document.createElement('span');
    label.className = 'ysl-wl-label';
    wrap.appendChild(button);
    wrap.appendChild(label);
    return wrap;
  }

  function buildRemoveButton(videoId) {
    const wrap = document.createElement('div');
    wrap.className = 'ysl-rm';
    wrap.dataset.vid = videoId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ysl-btn ysl-rm-btn';
    button.appendChild(svgIcon('ysl-icon-trash', ICON_TRASH));
    wrap.appendChild(button);
    setRemoveState(wrap, 'out');
    return wrap;
  }

  function setRemoveState(wrap, state) {
    const button = wrap.firstElementChild;
    button.dataset.state = state === 'failed' ? 'out' : state;
    button.title =
      state === 'busy'
        ? 'Removing from Watch Later…'
        : state === 'failed'
          ? 'Could not remove from Watch Later. Click to retry.'
          : 'Remove from Watch Later';
    button.setAttribute('aria-label', button.title);
    if (state === 'failed') wrap.dataset.error = '1';
    else delete wrap.dataset.error;
  }

  const LABELS = { in: 'Saved', out: 'Watch later', unknown: 'Watch later', busy: '…', failed: 'Failed' };

  function titleFor(state) {
    switch (state) {
      case 'in':
        return 'In Watch Later. Click to remove.';
      case 'out':
        return 'Add to Watch Later';
      case 'busy':
        return 'Updating Watch Later…';
      case 'failed':
        return 'Could not update Watch Later. Click to retry.';
      default:
        return wl.status === 'error'
          ? 'Could not load your Watch Later list. Click to add anyway.'
          : 'Checking Watch Later…';
    }
  }

  // `visual` is only used with state 'failed', to keep showing the state the
  // video was in before the failed request.
  function setState(wrap, state, visual = 'out') {
    const button = wrap.firstElementChild;
    const label = wrap.lastElementChild;
    button.dataset.state = state === 'failed' ? visual : state;
    button.setAttribute('aria-pressed', state === 'in' ? 'true' : 'false');
    button.title = titleFor(state);
    button.setAttribute('aria-label', button.title);
    label.textContent = LABELS[state];
    if (state === 'failed') wrap.dataset.error = '1';
    else delete wrap.dataset.error;
  }

  function stateFor(videoId, item) {
    if (wl.overrides.has(videoId)) return wl.overrides.get(videoId) ? 'in' : 'out';
    if (wl.status === 'ready') return wl.ids.has(videoId) ? 'in' : 'out';
    const hint = item ? hintFromItemData(item) : null;
    if (hint === true) return 'in';
    if (hint === false && wl.status === 'error') return 'out';
    return 'unknown';
  }

  function refreshButton(wrap) {
    const button = wrap.firstElementChild;
    if (button.dataset.state === 'busy' || wrap.dataset.error) return;
    setState(wrap, stateFor(wrap.dataset.vid, wrap.closest('ytd-rich-item-renderer')));
  }

  function updateAllButtons() {
    document.querySelectorAll('.ysl-wl').forEach(refreshButton);
  }

  function updateButtonsFor(videoId) {
    document.querySelectorAll('.ysl-wl').forEach((wrap) => {
      if (wrap.dataset.vid === videoId) refreshButton(wrap);
    });
  }

  async function toggleWatchLater(wrap) {
    const videoId = wrap.dataset.vid;
    const button = wrap.firstElementChild;
    if (button.dataset.state === 'busy') return;
    const wasIn = button.dataset.state === 'in';
    const operation = wasIn ? 'remove' : 'add';
    delete wrap.dataset.error;
    setState(wrap, 'busy');
    try {
      await editWatchLater(videoId, operation);
      wl.overrides.set(videoId, !wasIn);
      if (wasIn) wl.ids.delete(videoId);
      else wl.ids.add(videoId);
      log(`${operation === 'add' ? 'Added' : 'Removed'} ${videoId}`);
      setState(wrap, wasIn ? 'out' : 'in');
      updateButtonsFor(videoId);
    } catch (err) {
      warn(`Could not ${operation} ${videoId}:`, err);
      setState(wrap, 'failed', wasIn ? 'in' : 'out');
      setTimeout(() => {
        delete wrap.dataset.error;
        refreshButton(wrap);
      }, 3000);
    }
  }

  // Removes a row on the Watch Later playlist page. Prefers the playlist entry
  // id (setVideoId) that YouTube attaches to the row, which is what YouTube's
  // own "Remove from Watch later" menu item sends; falls back to the video id.
  async function removeFromWatchLater(wrap) {
    const button = wrap.firstElementChild;
    if (button.dataset.state === 'busy') return;
    const videoId = wrap.dataset.vid;
    const row = wrap.closest(PLAYLIST_ROWS);
    let setVideoId = null;
    try {
      setVideoId = (row && row.data && row.data.setVideoId) || null;
    } catch {
      /* ignore */
    }
    const actions = setVideoId
      ? [{ action: 'ACTION_REMOVE_VIDEO', setVideoId }]
      : [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }];
    setRemoveState(wrap, 'busy');
    try {
      const res = await innertube('browse/edit_playlist', { playlistId: 'WL', actions });
      if (res && res.status && res.status !== 'STATUS_SUCCEEDED') throw new Error(`edit_playlist returned ${res.status}`);
      wl.ids.delete(videoId);
      wl.overrides.set(videoId, false);
      updateButtonsFor(videoId);
      if (row) row.setAttribute('data-ysl-removed', '1');
      log(`Removed ${videoId} from Watch Later`);
    } catch (err) {
      warn(`Could not remove ${videoId} from Watch Later:`, err);
      setRemoveState(wrap, 'failed');
      setTimeout(() => setRemoveState(wrap, 'out'), 3000);
    }
  }

  function onClickCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    const button = target && target.closest('.ysl-btn');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.classList.contains('ysl-rm-btn')) removeFromWatchLater(button.parentElement);
    else toggleWatchLater(button.parentElement);
  }

  function swallowInsideButton(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('.ysl-wl, .ysl-rm')) event.stopImmediatePropagation();
  }

  document.addEventListener('click', onClickCapture, true);
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
    document.addEventListener(type, swallowInsideButton, true);
  }

  // ---------------------------------------------------------------------------
  // Feed processing
  // ---------------------------------------------------------------------------

  function videoIdFromHref(href) {
    const match = href.match(/[?&]v=([A-Za-z0-9_-]{11})/) || href.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  function setHidden(el, reason) {
    if (reason) {
      if (el.getAttribute('data-ysl-hidden') !== reason) el.setAttribute('data-ysl-hidden', reason);
    } else if (el.hasAttribute('data-ysl-hidden')) {
      el.removeAttribute('data-ysl-hidden');
    }
  }

  function describeSection(section) {
    const content = section.querySelector('#content > *');
    const title = section.querySelector('#title, h2, h3');
    return `${content ? content.tagName.toLowerCase() : '?'}${title ? ` "${title.textContent.trim()}"` : ''}`;
  }

  function processSection(section) {
    let reason = null;
    if (section.querySelector(SHORTS_SHELF)) {
      reason = settings.hideShorts ? 'shorts' : null;
    } else if (settings.hideShelves) {
      if (section.querySelector(OTHER_SHELF)) reason = 'shelf';
      else {
        const title = section.querySelector('#title, h2, h3');
        if (title && /most relevant/i.test(title.textContent)) reason = 'most-relevant';
      }
    }
    setHidden(section, reason);
    if (settings.debug && !section.dataset.yslLogged) {
      section.dataset.yslLogged = '1';
      log(`${reason ? `hid (${reason})` : 'kept'} section: ${describeSection(section)}`);
    }
  }

  function removeButton(item) {
    const wrap = item.querySelector('.ysl-wl');
    if (wrap) wrap.remove();
  }

  function processItem(item) {
    const link = item.querySelector(VIDEO_LINK);
    if (!link) return; // Not rendered yet; a later mutation pass will pick it up.
    const href = link.getAttribute('href') || '';
    const isShort = href.includes('/shorts/');
    setHidden(item, isShort && settings.hideShorts ? 'short' : null);

    const videoId = videoIdFromHref(href);
    const isPlaylist = /[?&]list=/.test(href);
    if (isShort || !videoId || isPlaylist || !settings.watchLater) {
      removeButton(item);
      return;
    }

    let wrap = item.querySelector('.ysl-wl');
    if (wrap && wrap.dataset.vid !== videoId) {
      wrap.remove();
      wrap = null;
    }
    if (!wrap) {
      const anchor = item.querySelector(THUMB_ANCHOR);
      if (!anchor) return;
      wrap = buildButton(videoId);
      anchor.insertAdjacentElement('afterend', wrap);
    }
    refreshButton(wrap);
  }

  function onSubscriptionsPage() {
    return location.pathname === '/feed/subscriptions' || Boolean(document.querySelector(`${SUBS_BROWSE}:not([hidden])`));
  }

  // ---------------------------------------------------------------------------
  // Watch Later playlist page
  // ---------------------------------------------------------------------------

  function processPlaylistRow(row) {
    const existing = row.querySelector('.ysl-rm');
    if (row.hasAttribute('data-ysl-removed')) return;
    const link = row.querySelector(PLAYLIST_ROW_LINK);
    const href = link ? link.getAttribute('href') || '' : '';
    const videoId = href && WATCH_LATER_LIST.test(href) ? videoIdFromHref(href) : null;
    if (!videoId || !settings.wlRemove) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.dataset.vid === videoId) return;
    if (existing) existing.remove();
    const content = row.querySelector('#content');
    if (!content) return;
    const wrap = buildRemoveButton(videoId);
    const menu = content.querySelector(':scope > #menu');
    if (menu) content.insertBefore(wrap, menu);
    else content.appendChild(wrap);
  }

  let cleanedUp = false;

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    document.querySelectorAll('[data-ysl-hidden]').forEach((el) => el.removeAttribute('data-ysl-hidden'));
    document.querySelectorAll('.ysl-wl, .ysl-rm').forEach((el) => el.remove());
  }

  function pass() {
    readSettings();
    if (!settings.enabled) {
      cleanup();
      return;
    }
    cleanedUp = false;
    const subsBrowses = document.querySelectorAll(SUBS_BROWSE);
    for (const browse of subsBrowses) {
      browse.querySelectorAll(FEED_SECTIONS).forEach(processSection);
      browse.querySelectorAll(FEED_ITEMS).forEach(processItem);
    }
    if (subsBrowses.length && settings.watchLater && onSubscriptionsPage()) refreshWatchLater(false);
    for (const browse of document.querySelectorAll(PLAYLIST_BROWSE)) {
      browse.querySelectorAll(PLAYLIST_ROWS).forEach(processPlaylistRow);
    }
  }

  let passTimer = 0;
  function schedulePass() {
    if (passTimer) return;
    passTimer = setTimeout(() => {
      passTimer = 0;
      try {
        pass();
      } catch (err) {
        warn('Unexpected error:', err);
      }
    }, 50);
  }

  const domObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' || record.addedNodes.length) {
        schedulePass();
        return;
      }
    }
  });

  const settingsObserver = new MutationObserver(schedulePass);

  function start() {
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'page-subtype', 'hidden'],
    });
    settingsObserver.observe(root, {
      attributes: true,
      attributeFilter: [
        'data-ysl',
        'data-ysl-hide-shorts',
        'data-ysl-hide-shelves',
        'data-ysl-watch-later',
        'data-ysl-wl-remove',
        'data-ysl-debug',
      ],
    });
    window.addEventListener('yt-navigate-finish', schedulePass);
    document.addEventListener('yt-page-data-updated', schedulePass);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') schedulePass();
    });
    schedulePass();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // Handy for debugging from the console.
  window.__ytSubsList = { settings, wl, pass, refreshWatchLater };
})();
