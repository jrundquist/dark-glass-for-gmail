// Measures how bright the Gmail theme wallpaper is, so the content script can
// thicken the glass over bright photos. Runs here because the image is served
// through a cross-origin redirect the page itself can't read.

// Theme images start at mail.google.com and redirect to lh3.google.com
// (covered by the "rd-mail-pt" host permission); email images come through
// googleusercontent.com.
const ALLOWED_HOSTS = [/^mail\.google\.com$/, /\.googleusercontent\.com$/, /\.gstatic\.com$/];
const cache = new Map(); // url -> stats

// Brightness (0-255) of the bright parts overall and behind the nav/header,
// plus the image's dominant color, weighted toward saturated pixels so a
// photo's mood wins over its grays.
function statsFromPixels(d, W, H) {
  const all = [], left = [], top = [];
  let tr = 0, tg = 0, tb = 0, tw = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      all.push(v);
      if (x < W * 0.2) left.push(v); // behind the nav
      if (y < H * 0.12) top.push(v); // behind the header
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const w = 0.05 + (max - min) / 255;
      tr += r * w; tg += g * w; tb += b * w; tw += w;
    }
  }
  const pct = (arr, q) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  return {
    p90: pct(all, 0.9),
    left: pct(left, 0.95),
    top: pct(top, 0.95),
    tint: [Math.round(tr / tw), Math.round(tg / tw), Math.round(tb / tw)],
  };
}

async function measure(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const bmp = await createImageBitmap(await res.blob());
  const W = 32, H = 18;
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  ctx.drawImage(bmp, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const stats = statsFromPixels(d, W, H);
  if (cache.size > 20) cache.clear();
  cache.set(url, stats);
  return stats;
}

// Looks at an email image: how much of it is transparent, and how dark its
// visible pixels are. Dark logos on transparency vanish on a dark background.
const imgCache = new Map();
async function inspectImage(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const bmp = await createImageBitmap(await res.blob());
  const S = 48;
  const cv = new OffscreenCanvas(S, S);
  const ctx = cv.getContext("2d");
  ctx.drawImage(bmp, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  let clear = 0, solid = 0, lumSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 24) { clear++; continue; }
    solid++;
    lumSum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  }
  const info = { clear: clear / (S * S), lum: solid ? lumSum / solid : 1 };
  if (imgCache.size > 500) imgCache.clear();
  imgCache.set(url, info);
  return info;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === "gg-img") {
    let u;
    try { u = new URL(msg.url); } catch { sendResponse(null); return; }
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.some((re) => re.test(u.hostname))) { sendResponse(null); return; }
    inspectImage(u.href).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type !== "gg-wall") return;
  let url;
  try {
    url = new URL(msg.url);
  } catch {
    sendResponse(null);
    return;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.some((re) => re.test(url.hostname))) {
    sendResponse(null);
    return;
  }
  measure(url.href).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // async response
});
