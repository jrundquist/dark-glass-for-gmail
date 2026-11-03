const DEFAULTS = globalThis.GG_DEFAULTS;

const SLIDERS = {
  glass: (v) => Math.round(v * 100) + "%",
  wallDim: (v) => Math.round(v * 100) + "%",
};

const systemDark = matchMedia("(prefers-color-scheme: dark)");
let current = { ...DEFAULTS };

function render() {
  for (const b of document.querySelectorAll("[data-set]")) {
    b.setAttribute("aria-checked", String(current[b.dataset.set] === b.dataset.value));
  }
  for (const [key, fmt] of Object.entries(SLIDERS)) {
    document.getElementById(key).value = current[key];
    document.getElementById(key + "-out").textContent = fmt(current[key]);
  }
  const on = current.mode === "on" || (current.mode === "auto" && systemDark.matches);
  document.getElementById("state").textContent = on ? "Active" : "Inactive";
}

let pending = {};
let timer = 0;
// storage.sync has a write quota, so batch slider drags.
const save = (patch) => {
  current = { ...current, ...patch };
  render();
  Object.assign(pending, patch);
  clearTimeout(timer);
  timer = setTimeout(() => {
    chrome.storage.sync.set(pending);
    pending = {};
  }, 150);
};

Promise.all([chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get({ health: null })]).then(([s, l]) => {
  current = { ...DEFAULTS, ...s };
  if (current.email === "paper") current.email = "light";
  render();
  const h = l.health;
  const el = document.getElementById("health");
  if (h?.paused) {
    el.textContent = "Paused on the last Gmail load: Gmail changed in a way that couldn't be converted safely.";
    el.hidden = false;
  }
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-set]");
  if (b) save({ [b.dataset.set]: b.dataset.value });
});
for (const key of Object.keys(SLIDERS)) {
  document.getElementById(key).addEventListener("input", (e) => save({ [key]: parseFloat(e.target.value) }));
}
document.getElementById("more").addEventListener("click", () => chrome.runtime.openOptionsPage());
systemDark.addEventListener("change", render);
