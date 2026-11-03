const DEFAULTS = globalThis.GG_DEFAULTS;
const ACCENTS = globalThis.GG_ACCENTS;
const WALLPAPERS = globalThis.GG_WALLPAPERS;

const RANGES = {
  glass: (v) => Math.round(v * 100) + "%",
  blur: (v) => v + "px",
  wallDim: (v) => Math.round(v * 100) + "%",
  paper: (v) => Math.round(v * 100) + "%",
  warmth: (v) => Math.round((v / 0.3) * 100) + "%",
};

const $ = (id) => document.getElementById(id);
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let current = { ...DEFAULTS };
let customUrl = null;

// ---------- build the pickers ----------

function buildWalls() {
  const box = $("walls");
  const items = [["gmail", "Gmail theme", null], ...Object.entries(WALLPAPERS).map(([k, w]) => [k, w.name, w.css]), ["custom", "Your image", null]];
  for (const [value, name, css] of items) {
    const b = document.createElement("button");
    b.className = "wall";
    b.setAttribute("role", "radio");
    b.dataset.set = "wallpaper";
    b.dataset.value = value;
    b.textContent = name;
    if (css) b.style.background = css;
    box.append(b);
  }
}

function buildSwatches() {
  const box = $("swatches");
  for (const [key, a] of Object.entries(ACCENTS)) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", a.name);
    b.title = a.name;
    b.dataset.set = "accent";
    b.dataset.value = key;
    b.style.background = a.auto ? "conic-gradient(#ff453a, #ff9f0a, #ffd60a, #32d74b, #0a84ff, #bf5af2, #ff453a)" : a.accent;
    b.style.color = a.auto ? "#bbb" : a.accent;
    box.append(b);
  }
}

// ---------- render ----------

function render() {
  for (const b of document.querySelectorAll("[data-set]")) {
    b.setAttribute("aria-checked", String(current[b.dataset.set] === b.dataset.value));
  }
  const customBtn = document.querySelector('.wall[data-value="custom"]');
  if (customBtn) {
    customBtn.style.backgroundImage = customUrl ? `url("${customUrl}")` : "";
    customBtn.disabled = !customUrl;
    customBtn.title = customUrl ? "" : "Choose an image first";
  }
  $("wall-remove").hidden = !customUrl;
  for (const [key, fmt] of Object.entries(RANGES)) {
    $(key).value = current[key];
    $(key + "-out").textContent = fmt(current[key]);
  }
  for (const t of document.querySelectorAll("[data-toggle]")) t.checked = !!current[t.dataset.toggle];
  const on = current.mode === "on" || (current.mode === "auto" && systemDark.matches);
  $("state").textContent = on ? "Active" : "Inactive";
  renderSenders();
}

function renderSenders() {
  const list = $("senders");
  list.replaceChildren();
  const entries = Object.entries(current.senders || {}).sort(([a], [b]) => a.localeCompare(b));
  $("senders-empty").hidden = entries.length > 0;
  for (const [email, choice] of entries) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = email;
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = choice === "original" ? "original colors" : "dark";
    who.append(what);
    const rm = document.createElement("button");
    rm.className = "link";
    rm.textContent = "Forget";
    rm.setAttribute("aria-label", `Forget ${email}`);
    rm.addEventListener("click", () => {
      const senders = { ...current.senders };
      delete senders[email];
      save({ senders });
    });
    li.append(who, rm);
    list.append(li);
  }
}

// ---------- save (batched: storage.sync has a write quota) ----------

let pending = {};
let timer = 0;
function save(patch) {
  current = { ...current, ...patch };
  render();
  Object.assign(pending, patch);
  clearTimeout(timer);
  timer = setTimeout(() => {
    chrome.storage.sync.set(pending);
    pending = {};
  }, 150);
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-set]");
  if (b && !b.disabled) save({ [b.dataset.set]: b.dataset.value });
});
for (const key of Object.keys(RANGES)) {
  $(key).addEventListener("input", (e) => save({ [key]: parseFloat(e.target.value) }));
}
for (const t of document.querySelectorAll("[data-toggle]")) {
  t.addEventListener("change", () => save({ [t.dataset.toggle]: t.checked }));
}
$("reset").addEventListener("click", () => save({ ...DEFAULTS }));

// ---------- custom wallpaper ----------

// Same measurement the background worker does for Gmail themes.
function statsFromPixels(d, W, H) {
  const all = [], left = [], top = [];
  let tr = 0, tg = 0, tb = 0, tw = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      all.push(v);
      if (x < W * 0.2) left.push(v);
      if (y < H * 0.12) top.push(v);
      const w = 0.05 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      tr += r * w; tg += g * w; tb += b * w; tw += w;
    }
  }
  const pct = (arr, q) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  return { p90: pct(all, 0.9), left: pct(left, 0.95), top: pct(top, 0.95), tint: [tr / tw, tg / tw, tb / tw].map(Math.round) };
}

$("wall-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    // Scale down to at most 2560px wide and store as JPEG (keeps storage small).
    const scale = Math.min(1, 2560 / bmp.width);
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * scale);
    cv.height = Math.round(bmp.height * scale);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL("image/jpeg", 0.85);
    const small = document.createElement("canvas");
    small.width = 32;
    small.height = 18;
    const sctx = small.getContext("2d");
    sctx.drawImage(bmp, 0, 0, 32, 18);
    const info = statsFromPixels(sctx.getImageData(0, 0, 32, 18).data, 32, 18);
    await chrome.storage.local.set({ customWall: url, customWallInfo: info });
    customUrl = url;
    save({ wallpaper: "custom" });
  } catch (err) {
    alert("That image couldn't be read. Try a JPEG or PNG.");
  } finally {
    e.target.value = "";
  }
});

$("wall-remove").addEventListener("click", async () => {
  await chrome.storage.local.remove(["customWall", "customWallInfo"]);
  customUrl = null;
  save({ wallpaper: current.wallpaper === "custom" ? "gmail" : current.wallpaper });
});

// ---------- health ----------

function renderHealth(h) {
  const el = $("health");
  if (!h) { el.hidden = true; return; }
  if (h.paused) {
    el.textContent = "Dark mode paused itself: Gmail changed in a way it couldn't convert safely. It will try again next time Gmail loads.";
    el.hidden = false;
  } else if (!h.panel && h.main) {
    el.textContent = "Some parts of Gmail weren't recognized on the last load, so the glass panel may be missing.";
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ---------- start ----------

buildWalls();
buildSwatches();
Promise.all([chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get({ customWall: null, health: null })]).then(([s, l]) => {
  current = { ...DEFAULTS, ...s };
  customUrl = l.customWall;
  render();
  renderHealth(l.health);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.health) renderHealth(changes.health.newValue);
});
systemDark.addEventListener("change", render);
