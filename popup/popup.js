const DEFAULTS = {
  enabled: true,
  thumbWidth: 240,
  hideShorts: true,
  hideShelves: true,
  watchLater: true,
  wlRemove: true,
  debug: false,
};

const checkboxes = ['enabled', 'hideShorts', 'hideShelves', 'watchLater', 'wlRemove', 'debug'];

const manifest = chrome.runtime.getManifest();
document.title = manifest.name;
document.getElementById('title').textContent = manifest.name;
const thumbWidth = document.getElementById('thumbWidth');
const thumbWidthValue = document.getElementById('thumbWidthValue');

function render(settings) {
  for (const key of checkboxes) {
    document.getElementById(key).checked = Boolean(settings[key]);
  }
  thumbWidth.value = settings.thumbWidth;
  thumbWidthValue.textContent = `${settings.thumbWidth}px`;
  document.body.classList.toggle('disabled', !settings.enabled);
}

function save(partial) {
  chrome.storage.sync.set(partial);
}

chrome.storage.sync.get(DEFAULTS, (settings) => render({ ...DEFAULTS, ...settings }));

for (const key of checkboxes) {
  document.getElementById(key).addEventListener('change', (e) => {
    save({ [key]: e.target.checked });
    if (key === 'enabled') document.body.classList.toggle('disabled', !e.target.checked);
  });
}

thumbWidth.addEventListener('input', () => {
  thumbWidthValue.textContent = `${thumbWidth.value}px`;
});
thumbWidth.addEventListener('change', () => save({ thumbWidth: Number(thumbWidth.value) }));
