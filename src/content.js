// Isolated-world content script.
//
// Its only job is to mirror the extension settings onto the <html> element as
// data-attributes and a CSS variable. styles.css keys off those attributes, and
// page.js (which runs in the page's main world and therefore has no access to
// chrome.storage) reads them from there.

const DEFAULTS = {
  enabled: true,
  thumbWidth: 240,
  hideShorts: true,
  hideShelves: true,
  watchLater: true,
  wlRemove: true,
  debug: false,
};

function apply(settings) {
  const root = document.documentElement;
  const onOff = (v) => (v ? 'on' : 'off');
  root.dataset.ysl = onOff(settings.enabled);
  root.dataset.yslHideShorts = onOff(settings.hideShorts);
  root.dataset.yslHideShelves = onOff(settings.hideShelves);
  root.dataset.yslWatchLater = onOff(settings.watchLater);
  root.dataset.yslWlRemove = onOff(settings.wlRemove);
  root.dataset.yslDebug = onOff(settings.debug);
  const width = Math.max(120, Math.min(600, Number(settings.thumbWidth) || DEFAULTS.thumbWidth));
  root.style.setProperty('--ysl-thumb-width', `${width}px`);
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (settings) => {
    if (chrome.runtime.lastError) {
      apply(DEFAULTS);
      return;
    }
    apply({ ...DEFAULTS, ...settings });
  });
}

load();
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') load();
});
