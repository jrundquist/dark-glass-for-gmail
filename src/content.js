// Dark Glass for Gmail: content script.
//
//  1. Mode: on/off from system dark mode (or the user's override), with a
//     crossfade when it flips.
//  2. Stylesheet rewriter: reads Gmail's own CSS and writes a dark version of
//     every color rule and Material token. No Gmail class names involved, so it
//     survives Gmail renaming its compiled classes.
//  3. Structure tagging: finds the main panel, wallpaper, rows and message
//     bodies using ARIA roles, data-* attributes and DOM shape, and marks them
//     with data-gg-* attributes that glass.css styles.
//  4. Emails: plain emails get light text; designed emails are recolored to
//     dark (or shown on a light card), with a per-email / per-sender toggle.
//  5. Wallpaper: Gmail's theme image, a built-in gradient or the user's own
//     image. Its brightness sets how thick the glass is; its color tints it.
(() => {
  const C = globalThis.GGColor;
  const DEFAULTS = globalThis.GG_DEFAULTS;
  const ACCENTS = globalThis.GG_ACCENTS;
  const WALLPAPERS = globalThis.GG_WALLPAPERS;
  const root = document.documentElement;
  const LOG = "[gmail-dark-glass]";

  // Embedded Google widgets (contact cards) get only the color rewrite, and
  // only when they're shown inside Gmail: on other sites they stay as they are.
  const IS_FRAME = window !== window.top;
  if (IS_FRAME) {
    const parent = location.ancestorOrigins?.[0] || "";
    if (parent !== "https://mail.google.com") return;
    root.setAttribute("data-gg-frame", "");
  }

  // The only Gmail class name used. Message bodies have no ARIA role or data
  // attribute of their own, so we look inside [data-message-id] for this and
  // fall back to the biggest text block if it ever disappears.
  const BODY_CLASS_FALLBACK = ".a3s";

  let settings = { ...DEFAULTS };
  let custom = { url: null, info: null }; // user wallpaper (storage.local)
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  // macOS "Increase contrast" / "Reduce transparency" / "Reduce motion", Windows high contrast.
  const moreContrast = matchMedia("(prefers-contrast: more)");
  const reduceTransparency = matchMedia("(prefers-reduced-transparency: reduce)");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const forcedColors = matchMedia("(forced-colors: active)");
  // Gmail's print and "show original" pages should stay light.
  const isPrintView = /[?&]view=(pt|om)\b/.test(location.search);
  let printing = false;
  let paused = false; // set by the health check if Gmail's structure changed
  let active = false;
  let booted = false; // after the first settings load: mode changes crossfade

  // ---------------------------------------------------------------- glass math

  // Brightness of the wallpaper (0-255, sRGB). p90 = bright parts behind the
  // panel, left/top = behind the nav and header. Before it's known we assume
  // the worst (a white wallpaper), which keeps text safe.
  const WORST = { p90: 255, left: 255, top: 255 };
  let themeInfo = null; // measured Gmail theme image: { p90, left, top, tint }

  const DEFAULT_GLASS = [16, 18, 25];
  const DEFAULT_FLOAT = [28, 30, 38];

  function luma([r, g, b]) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Opacity a dark layer of brightness `base` needs over a background of
  // brightness v so the result is no brighter than `target`.
  function alphaFor(v, target, base) {
    if (v <= target) return 0;
    return Math.min(0.94, (v - target) / (v - base));
  }

  function hslToRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }

  // Dark glass colors tinted toward the wallpaper's color, the way macOS
  // sidebars pick up the desktop.
  function tintedGlass(tint) {
    if (!settings.tint || !tint) return { glass: DEFAULT_GLASS, float: DEFAULT_FLOAT };
    const [h, s] = C.toHsl([...tint, 1]);
    return {
      glass: hslToRgb(h, Math.min(s * 0.55, 0.3), 0.085),
      float: hslToRgb(h, Math.min(s * 0.45, 0.24), 0.135),
    };
  }

  // Accent: a fixed macOS color, or "Match wallpaper": a vivid version of
  // the wallpaper's color (blue if the wallpaper is too gray to have one).
  // `link` is a light tone of it that passes 4.5:1 as text on the glass.
  function pickAccent(tint) {
    const fixed = ACCENTS[settings.accent];
    if (fixed && !fixed.auto) {
      return { accent: C.parse(fixed.accent).slice(0, 3), link: C.parse(fixed.link).slice(0, 3) };
    }
    const [h, s] = tint ? C.toHsl([...tint, 1]) : [0, 0];
    if (!tint || s < 0.12) {
      const b = ACCENTS.blue;
      return { accent: C.parse(b.accent).slice(0, 3), link: C.parse(b.link).slice(0, 3) };
    }
    const sat = Math.min(0.92, Math.max(0.7, s * 1.6));
    return { accent: hslToRgb(h, sat, 0.56), link: hslToRgb(h, 0.9, 0.78) };
  }

  // Which wallpaper is showing: Gmail's theme image ("theme"), or our layer
  // ("ours") with a built-in gradient or the user's image.
  function wallSource() {
    const hasTheme = wallEls.length > 0;
    if (settings.wallpaper === "custom" && custom.url) return { kind: "custom", info: custom.info };
    if (settings.wallpaper !== "gmail" && WALLPAPERS[settings.wallpaper]) {
      const w = WALLPAPERS[settings.wallpaper];
      return { kind: "preset", info: { ...w.stats, tint: w.tint }, css: w.css };
    }
    if (hasTheme) return { kind: "theme", info: themeInfo };
    const w = WALLPAPERS.aurora;
    return { kind: "preset", info: { ...w.stats, tint: w.tint }, css: w.css };
  }

  let wallStyle = null;
  function setWallpaperCss(css) {
    if (!wallStyle) {
      wallStyle = document.createElement("style");
      wallStyle.id = "gg-wall";
    }
    const text = css ? `:root{--gg-wallpaper:${css}}` : "";
    if (wallStyle.textContent !== text) wallStyle.textContent = text;
    if (!wallStyle.isConnected) (document.head || root).appendChild(wallStyle);
  }

  // Gmail shares its live accent and glass colors so embedded widgets match.
  let liveTheme = null;
  let sharedJson = "";
  function shareTheme(theme) {
    const json = JSON.stringify(theme);
    if (json === sharedJson) return;
    sharedJson = json;
    globalThis.chrome?.storage?.local?.set({ liveTheme: theme });
  }

  function applyFrameVars() {
    const s = root.style;
    const t = liveTheme || { accent: [10, 132, 255], link: [142, 195, 255], float: DEFAULT_FLOAT };
    s.setProperty("--gg-accent-rgb", t.accent.join(", "));
    s.setProperty("--gg-link", `rgb(${t.link.join(", ")})`);
    s.setProperty("--gg-link-rgb", t.link.join(", "));
    s.setProperty("--gg-float-rgb", t.float.join(", "));
  }

  function applyVars() {
    if (IS_FRAME) return applyFrameVars();
    const s = root.style;
    const hc = moreContrast.matches;
    const src = wallSource();
    root.setAttribute("data-gg-wall", src.kind === "theme" ? "theme" : "ours");
    if (src.kind === "custom") setWallpaperCss(`url("${custom.url}") center / cover no-repeat, #0b0d12`);
    else if (src.kind === "preset") setWallpaperCss(src.css);
    else setWallpaperCss(null);

    const stats = src.info && Number.isFinite(src.info.p90) ? src.info : WORST;
    const { glass, float } = tintedGlass(src.info?.tint);
    const base = luma(glass);
    const dim = hc ? Math.min(settings.wallDim, 0.45) : settings.wallDim;
    // The composited background must stay at or below this brightness. Rows
    // add a faint white veil on top, so leave headroom: this keeps gray
    // secondary text above 4.5:1 (about 7:1 with Increase contrast).
    const target = hc ? 36 : 46;
    let panel = Math.max(settings.glass, alphaFor(stats.p90 * dim, target, base));
    if (hc) panel = Math.max(panel, 0.85);
    const navTarget = hc ? 36 : 56;

    s.setProperty("--gg-glass-rgb", glass.join(", "));
    s.setProperty("--gg-float-rgb", float.join(", "));
    s.setProperty("--gg-panel-alpha", panel.toFixed(3));
    s.setProperty("--gg-scrim-nav", alphaFor(stats.left * dim, navTarget, 10).toFixed(3));
    s.setProperty("--gg-scrim-top", alphaFor(stats.top * dim, navTarget, 10).toFixed(3));
    s.setProperty("--gg-blur", settings.blur + "px");
    s.setProperty("--gg-wall-dim", String(dim));
    s.setProperty("--gg-paper", String(settings.paper));
    s.setProperty("--gg-warmth", String(settings.warmth || 0));

    const accent = pickAccent(src.info?.tint);
    s.setProperty("--gg-accent", `rgb(${accent.accent.join(", ")})`);
    s.setProperty("--gg-accent-rgb", accent.accent.join(", "));
    s.setProperty("--gg-link", `rgb(${accent.link.join(", ")})`);
    s.setProperty("--gg-link-rgb", accent.link.join(", "));
    shareTheme({ accent: accent.accent, link: accent.link, float });

    root.toggleAttribute("data-gg-motion", settings.motion && !reduceMotion.matches);
    root.toggleAttribute("data-gg-focus-read", !!settings.focusRead);
  }

  // ---------------------------------------------------------------- mode

  function wantOn() {
    return (
      !paused &&
      !isPrintView &&
      !printing &&
      !forcedColors.matches &&
      (settings.mode === "on" || (settings.mode === "auto" && systemDark.matches))
    );
  }

  function setActive(want) {
    active = want;
    root.setAttribute("data-gg", want ? "on" : "off");
    resetBodies();
    if (want) {
      scheduleSheets(true);
      scheduleTag();
    }
  }

  let lastEmail = null;
  let lastSenders = null;
  function update() {
    root.toggleAttribute("data-gg-contrast", moreContrast.matches);
    root.toggleAttribute("data-gg-solid", reduceTransparency.matches);
    const floorChanged = C.setFgFloor(moreContrast.matches ? 0.82 : 0.75);
    if (floorChanged) clearSheetCache();
    applyVars();

    const sendersJson = JSON.stringify(settings.senders || {});
    const emailChanged = lastEmail !== null && (lastEmail !== settings.email || lastSenders !== sendersJson);
    lastEmail = settings.email;
    lastSenders = sendersJson;
    root.setAttribute("data-gg-email", settings.email);

    const want = wantOn();
    if (want === active) {
      if (floorChanged && active) scheduleSheets(true);
      if (emailChanged && active) { resetBodies(); scheduleTag(); }
      return;
    }
    // A live flip (e.g. macOS switching to dark at sunset) crossfades.
    if (booted && !printing && document.startViewTransition && settings.motion && !reduceMotion.matches) {
      document.startViewTransition(() => setActive(want));
    } else {
      setActive(want);
    }
  }

  // Set the attribute right away so glass.css can paint dark before Gmail
  // loads. The full update() runs at the bottom, once everything is defined.
  root.setAttribute("data-gg", systemDark.matches && !isPrintView && !forcedColors.matches ? "on" : "off");

  // ------------------------------------------------------ sheet rewriter

  const PROP_KIND = {
    color: "fg",
    "caret-color": "fg",
    fill: "fg",
    stroke: "fg",
    "outline-color": "fg",
    "text-decoration-color": "fg",
    "-webkit-text-fill-color": "fg",
    "background-color": "bg",
    "border-top-color": "border",
    "border-right-color": "border",
    "border-bottom-color": "border",
    "border-left-color": "border",
    "border-block-start-color": "border",
    "border-block-end-color": "border",
    "border-inline-start-color": "border",
    "border-inline-end-color": "border",
    "column-rule-color": "border",
  };

  // Custom properties (Material 3 tokens like --gm3-sys-color-on-surface) are
  // sorted by what their name says they are for. Unknown names are skipped.
  function varKind(name) {
    const n = name.toLowerCase();
    if (/shadow|elevation|gradient|inverse|opacity|font|radius|size|spacing|duration|easing|weight|line-height|width|height/.test(n)) return null;
    if (/(^|-)on-(primary|secondary|tertiary|error)$/.test(n)) return "onAccent";
    if (/(^|-)on-|text|label|icon|foreground|ink|caret|title|link|state-layer/.test(n)) return "fg";
    if (/outline|border|divider|stroke/.test(n)) return "border";
    if (/surface|container|background|(^|-)bg(-|$)|scrim|selected|highlight/.test(n)) return "bg";
    if (/primary|secondary|tertiary|error|accent|brand/.test(n)) return "fg";
    return null;
  }

  const STICKY = /^(sticky|fixed)$/;
  const STICKY_BG = "var(--gg-sticky)";

  const SHORTHANDS = [
    ["background", "bg"],
    ["border", "border"],
    ["border-color", "border"],
    ["border-top", "border"],
    ["border-right", "border"],
    ["border-bottom", "border"],
    ["border-left", "border"],
    ["border-block", "border"],
    ["border-inline", "border"],
    ["outline", "fg"],
  ];

  function mapDecl(st, prop, value, kind) {
    const mapped = C.mapValue(value, kind);
    if (mapped == null) return null;
    // Sticky/fixed bars (reply bar, toolbars) can't go fully see-through, or
    // content scrolling under them shows through: they become frosted glass.
    if (
      kind === "bg" &&
      !prop.startsWith("--") &&
      STICKY.test(st.getPropertyValue("position")) &&
      /^(transparent|rgba\(255, 255, 255,)/.test(mapped)
    ) return STICKY_BG;
    return mapped;
  }

  // A shadow without a color uses currentColor, which is now light text.
  // Give those an explicit dark color; turn light "separator" shadows faint.
  function mapShadow(value) {
    if (value === "none" || /var\(/.test(value)) return C.mapValue(value, "shadow");
    let changed = false;
    const parts = splitTopLevel(value).map((part) => {
      if (/rgba?\(|#[0-9a-f]{3,8}\b|\b(white|black|transparent|currentcolor)\b|hsla?\(/i.test(part)) {
        const m = C.mapValue(part, "shadow");
        if (m != null) { changed = true; return m; }
        return part;
      }
      changed = true;
      return part.trim() + " rgba(0, 0, 0, 0.35)";
    });
    return changed ? parts.join(",") : null;
  }

  // Monochrome dark icon sprites (Gmail's light-theme icons) get inverted.
  const DARK_ICON = /[_\/](?:baseline_)?(?:nv[5-9]00|black|(?:gm_)?grey(?:[5-9]00)?|n[5-9]00)(?:[_.]|$)|ita_sprite/i;
  const ICON_URL = /url\([^)]*(?:\/icons\/|ita_sprite)[^)]*\)/i;

  function splitTopLevel(text) {
    const out = [];
    let depth = 0, start = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== "\\") quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  }

  // :where() keeps the original specificity, so Gmail's own cascade
  // (hover, selected, unread...) resolves the same way in dark.
  function scopeSelector(sel) {
    sel = sel.trim();
    if (/^(html|:root)(?![\w-])/i.test(sel)) return sel.replace(/^(html|:root)/i, '$1:where([data-gg="on"])');
    return ':where(html[data-gg="on"]) ' + sel;
  }

  let ruleCount = 0;
  function rewriteStyleRule(rule) {
    const st = rule.style;
    const decls = [];
    const push = (prop, mapped) => {
      decls.push(`${prop}:${mapped} !important`);
      if (mapped === STICKY_BG) {
        decls.push("-webkit-backdrop-filter:var(--gg-sticky-filter) !important", "backdrop-filter:var(--gg-sticky-filter) !important");
      }
    };
    for (let i = 0; i < st.length; i++) {
      const prop = st[i];
      const value = st.getPropertyValue(prop);
      if (!value) continue;
      if (prop === "box-shadow") {
        const mapped = mapShadow(value);
        if (mapped != null) decls.push(`box-shadow:${mapped} !important`);
        continue;
      }
      const kind = prop.startsWith("--") ? varKind(prop) : PROP_KIND[prop];
      if (!kind) continue;
      const mapped = mapDecl(st, prop, value, kind);
      if (mapped != null) push(prop, mapped);
    }
    // A shorthand that uses var() leaves its longhands empty in the CSSOM,
    // so read the shorthand itself.
    for (const [prop, kind] of SHORTHANDS) {
      const value = st.getPropertyValue(prop);
      if (!value || !value.includes("var(")) continue;
      const mapped = mapDecl(st, prop, value, kind);
      if (mapped != null) push(prop, mapped);
    }
    const bi = st.getPropertyValue("background-image");
    if (bi && ICON_URL.test(bi)) {
      const orig = st.getPropertyValue("filter");
      decls.push(
        DARK_ICON.test(bi)
          ? "filter:invert(1) hue-rotate(180deg) brightness(1.05) !important"
          : `filter:${orig || "none"} !important`
      );
    }
    if (!decls.length) return "";
    ruleCount++;
    return splitTopLevel(rule.selectorText).map(scopeSelector).join(",") + "{" + decls.join(";") + "}";
  }

  function rewriteRules(rules) {
    let out = "";
    for (const rule of rules) {
      if (rule.selectorText !== undefined && rule.style) {
        out += rewriteStyleRule(rule);
        if (rule.cssRules?.length) out += rewriteRules(rule.cssRules); // nested CSS
      } else if (rule.cssRules) {
        let head = null;
        if (rule instanceof CSSMediaRule) head = "@media " + rule.conditionText;
        else if (rule instanceof CSSSupportsRule) head = "@supports " + rule.conditionText;
        else if (globalThis.CSSContainerRule && rule instanceof CSSContainerRule) head = "@container " + rule.conditionText;
        else if (globalThis.CSSLayerBlockRule && rule instanceof CSSLayerBlockRule) head = "";
        if (head === null) continue;
        const inner = rewriteRules(rule.cssRules);
        if (inner) out += head ? `${head}{${inner}}` : inner;
      }
    }
    return out;
  }

  let sheetCache = new WeakMap(); // sheet -> { len, css, rules }
  let outStyle = null;
  let lastCss = "";
  let totalRules = 0;

  function clearSheetCache() {
    sheetCache = new WeakMap();
    lastCss = "";
  }

  function isOurs(sheet) {
    const n = sheet.ownerNode;
    return n && n.id && n.id.startsWith("gg-");
  }
  // Styles that ship inside an email belong to the sender, not Gmail.
  function isEmailSheet(sheet) {
    const n = sheet.ownerNode;
    return !!(n && n.closest && n.closest("[data-message-id]"));
  }

  function rebuildSheets() {
    if (!active) return;
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    let css = "";
    let count = 0;
    for (const sheet of sheets) {
      if (isOurs(sheet) || isEmailSheet(sheet)) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      let cached = sheetCache.get(sheet);
      if (!cached || cached.len !== rules.length) {
        ruleCount = 0;
        cached = { len: rules.length, css: rewriteRules(rules), rules: ruleCount };
        sheetCache.set(sheet, cached);
      }
      css += cached.css;
      count += cached.rules;
    }
    totalRules = count;
    if (!outStyle) {
      outStyle = document.createElement("style");
      outStyle.id = "gg-rewritten";
    }
    if (css !== lastCss) {
      outStyle.textContent = css;
      lastCss = css;
    }
    // Stay after Gmail's sheets so equal-specificity !important rules resolve to ours.
    const parent = document.head || root;
    if (outStyle.parentNode !== parent || outStyle !== parent.lastElementChild) parent.appendChild(outStyle);
  }

  // At most once per frame, so new Gmail styles get a dark twin before they paint.
  let sheetFrame = 0;
  function scheduleSheets(now) {
    if (now) { cancelAnimationFrame(sheetFrame); sheetFrame = 0; rebuildSheets(); return; }
    if (sheetFrame) return;
    sheetFrame = requestAnimationFrame(() => { sheetFrame = 0; rebuildSheets(); });
  }

  // Gmail sometimes inserts rules into an existing sheet, which no mutation
  // reports, so check rule counts now and then (cheap).
  setInterval(() => {
    if (!active) return;
    for (const sheet of document.styleSheets) {
      const c = sheetCache.get(sheet);
      if (!c) continue;
      try { if (sheet.cssRules.length !== c.len) return scheduleSheets(); } catch {}
    }
  }, 3000);

  // ------------------------------------------------------ structure tags

  function setTag(attr, el) {
    for (const old of document.querySelectorAll(`[${attr}]`)) if (old !== el) old.removeAttribute(attr);
    if (el && !el.hasAttribute(attr)) el.setAttribute(attr, "");
  }

  // Main glass panel: walk up from [role=main] to the highest ancestor that
  // does not also hold the navigation, then take its child that holds main.
  function findPanel() {
    const main = document.querySelector('[role="main"]');
    if (!main) return null;
    let node = main;
    while (
      node.parentElement &&
      node.parentElement !== document.body &&
      !node.parentElement.querySelector('[role="navigation"]')
    ) node = node.parentElement;
    return [...node.children].find((c) => c.contains(main)) || node;
  }

  // Theme wallpaper: big elements with a url() background near the top of
  // the DOM, inside a fixed layer (tagged as the wallpaper root).
  let wallEls = [];
  function findWallpaper() {
    if (wallEls.length && wallEls.every((e) => e.isConnected)) return;
    for (const e of wallEls) e.removeAttribute("data-gg-wallpaper");
    wallEls = [];
    const vw = innerWidth, vh = innerHeight;
    const divs = document.body.getElementsByTagName("div");
    const limit = Math.min(divs.length, 400);
    for (let i = 0; i < limit; i++) {
      const d = divs[i];
      if (d.closest("[role]")) continue;
      const bi = getComputedStyle(d).backgroundImage;
      if (!bi || !bi.startsWith("url(")) continue;
      if (d.offsetWidth >= vw * 0.8 && d.offsetHeight >= vh * 0.8) wallEls.push(d);
    }
    for (const e of wallEls) e.setAttribute("data-gg-wallpaper", "");
    let wallRoot = wallEls[0] || null;
    while (wallRoot && wallRoot !== document.body && getComputedStyle(wallRoot).position !== "fixed") wallRoot = wallRoot.parentElement;
    setTag("data-gg-wallroot", wallRoot && wallRoot !== document.body ? wallRoot : null);
    applyVars();
    measureTheme();
  }

  // Sample the Gmail theme image so the glass can thicken over bright photos
  // and pick up its color. Until then (or if it fails) worst-case values apply.
  let measuredUrl = null;
  async function measureTheme() {
    const el = wallEls[0];
    const m = el && getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
    const url = m ? m[1] : null;
    if (url === measuredUrl) return;
    measuredUrl = url;
    themeInfo = null;
    applyVars();
    if (!url) return;
    // Gmail serves the theme image through a cross-origin redirect, so the
    // page can't read its pixels. The background worker (with host
    // permissions) fetches and measures it.
    let info = null;
    try {
      info = await chrome.runtime.sendMessage({ type: "gg-wall", url: new URL(url, location.href).href });
    } catch (e) {
      info = { error: String(e) };
    }
    if (info?.error) console.warn(LOG, "could not measure the theme wallpaper; using the safest glass", info.error);
    else console.debug(LOG, "wallpaper", info);
    if (url !== measuredUrl) return; // theme changed meanwhile
    themeInfo = info && Number.isFinite(info.p90) ? info : null;
    applyVars();
  }

  function findBody(msg) {
    const byClass = msg.querySelector(BODY_CLASS_FALLBACK);
    if (byClass) return byClass;
    // Fallback: the deepest element that still holds most of the message text.
    const total = msg.textContent.length;
    if (!total) return null;
    let best = null;
    for (const el of msg.querySelectorAll("div")) {
      if (!el.closest("[data-gg-ui]") && el.textContent.length >= total * 0.6) best = el;
    }
    return best;
  }

  // Unread rows: Gmail shows them by making the sender bold, so read that.
  // Important markers: switches whose label mentions "important" (or whose
  // icon does, in other languages); the checked ones get the accent color.
  const IMPORTANT = /important/i;
  function tagRows() {
    const rows = document.querySelectorAll('[role="main"] [role="row"]');
    const n = Math.min(rows.length, 200);
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const sender = row.querySelector("[email]");
      const unread = !!sender && parseInt(getComputedStyle(sender).fontWeight, 10) >= 600;
      if (unread !== row.hasAttribute("data-gg-unread")) row.toggleAttribute("data-gg-unread", unread);
      for (const sw of row.querySelectorAll('[role="switch"]')) tagImportant(sw);
    }
  }

  function tagImportant(sw) {
    const label = (sw.getAttribute("aria-label") || "") + (sw.getAttribute("data-tooltip") || "");
    let icon = sw.querySelector("[data-gg-imp]");
    if (!icon) {
      for (const e of [sw, ...sw.querySelectorAll("*")]) {
        const bi = getComputedStyle(e).backgroundImage;
        if (bi.startsWith("url(")) { icon = e; break; }
      }
    }
    if (!icon) return;
    const isImportantSwitch = IMPORTANT.test(label) || /arrow|important/i.test(icon.style.getPropertyValue("--gg-imp-url") || getComputedStyle(icon).backgroundImage);
    const on = isImportantSwitch && sw.getAttribute("aria-checked") === "true";
    if (!on) {
      if (icon.hasAttribute("data-gg-imp")) icon.removeAttribute("data-gg-imp");
      return;
    }
    if (icon.hasAttribute("data-gg-imp")) return;
    const cs = getComputedStyle(icon);
    icon.style.setProperty("--gg-imp-url", cs.backgroundImage);
    icon.style.setProperty("--gg-imp-pos", cs.backgroundPosition);
    icon.style.setProperty("--gg-imp-size", cs.backgroundSize === "auto" ? "contain" : cs.backgroundSize);
    icon.setAttribute("data-gg-imp", "");
  }

  // Where the nav ends and the header stops, for the wallpaper vignette, and
  // whether the nav is floating over the panel (it slides out on hover when
  // collapsed): then it needs a glass backing of its own.
  function trackChrome() {
    const nav = document.querySelector('[role="navigation"]');
    const banner = document.querySelector('[role="banner"]');
    const panel = document.querySelector("[data-gg-panel]");
    const s = root.style;
    if (nav) {
      const right = nav.getBoundingClientRect().right;
      const floating = !!panel && right > panel.getBoundingClientRect().left + 4;
      if (floating !== root.hasAttribute("data-gg-nav-float")) root.toggleAttribute("data-gg-nav-float", floating);
      if (!floating) s.setProperty("--gg-nav-w", Math.round(right) + "px");
    }
    if (banner) s.setProperty("--gg-top-h", Math.round(banner.getBoundingClientRect().bottom) + "px");
  }

  // ------------------------------------------------------ email bodies

  const INLINE_TAGS = new Set(["SPAN", "FONT", "B", "I", "U", "EM", "STRONG", "A", "MARK", "CODE", "SMALL", "SUB", "SUP"]);

  function isRich(body) {
    const els = body.getElementsByTagName("*");
    const n = Math.min(els.length, 5000);
    let wideTable = false, bigImgs = 0;
    for (let i = 0; i < n; i++) {
      const e = els[i];
      const bgAttr = e.getAttribute("bgcolor");
      if (bgAttr) {
        const c = C.parse(bgAttr);
        if (!c || c[3] > 0) return true;
      }
      if (!INLINE_TAGS.has(e.tagName) && e.style && (e.style.backgroundColor || e.style.backgroundImage)) {
        const c = C.parse(e.style.backgroundColor);
        if (e.style.backgroundImage.startsWith("url(") || (c && c[3] > 0.1)) return true;
      }
      if (e.tagName === "TABLE") {
        const w = parseInt(e.getAttribute("width") || e.style.width || "0", 10);
        if (w >= 480) wideTable = true;
      } else if (e.tagName === "IMG" && (parseInt(e.getAttribute("width") || "0", 10) >= 200 || e.naturalWidth >= 200)) {
        bigImgs++;
      }
    }
    return wideTable && (bigImgs > 0 || n > 150);
  }

  // Emails the sender already designed dark: the largest painted surface is dark.
  function isDarkDesigned(body) {
    const bodyArea = body.offsetWidth * body.offsetHeight;
    if (!bodyArea) return false;
    let best = null, bestArea = 0;
    const els = body.getElementsByTagName("*");
    const n = Math.min(els.length, 3000);
    for (let i = 0; i < n; i++) {
      const e = els[i];
      const c = C.parse(getComputedStyle(e).backgroundColor);
      if (!c || c[3] < 0.5) continue;
      const area = e.offsetWidth * e.offsetHeight;
      if (area > bestArea) { best = c; bestArea = area; }
    }
    return !!best && bestArea >= bodyArea * 0.4 && C.luminance(best) < 0.06;
  }

  function setFix(el, prop, value) {
    if (!el.hasAttribute("data-gg-fix")) el.setAttribute("data-gg-fix", "{}");
    const orig = JSON.parse(el.getAttribute("data-gg-fix"));
    if (!(prop in orig)) {
      orig[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
      el.setAttribute("data-gg-fix", JSON.stringify(orig));
    }
    el.style.setProperty(prop, value, "important");
  }

  function revertFixes(scope) {
    for (const el of scope.querySelectorAll("[data-gg-plate]")) el.removeAttribute("data-gg-plate");
    for (const el of scope.querySelectorAll("[data-gg-fix]")) {
      const orig = JSON.parse(el.getAttribute("data-gg-fix") || "{}");
      for (const [prop, [v, p]] of Object.entries(orig)) {
        if (v) el.style.setProperty(prop, v, p);
        else el.style.removeProperty(prop);
      }
      el.removeAttribute("data-gg-fix");
    }
  }

  // Plain emails: lighten any dark inline text colors the sender set, keep
  // highlights readable.
  function fixPlain(body) {
    for (const e of body.querySelectorAll("[style], font[color]")) {
      if (e.hasAttribute("data-gg-fix")) continue;
      const cs = getComputedStyle(e);
      const bgc = C.parse(e.style.backgroundColor);
      if (bgc && bgc[3] > 0.1) {
        const [, , l] = C.toHsl(bgc);
        if (l >= 0.5) { setFix(e, "color", "#111"); continue; } // highlighter
      }
      const c = C.parse(cs.color);
      if (!c) continue;
      const m = C.fg(c);
      if (m) setFix(e, "color", m);
    }
  }

  const BORDER_SIDES = ["top", "right", "bottom", "left"];

  // Designed emails in dark: light surfaces become dark glass, dark text
  // becomes light. Anything the sender put on a strong color or a background
  // image is left exactly as designed, since its text was chosen for that
  // color.
  function fixDark(body) {
    const els = body.getElementsByTagName("*");
    const n = Math.min(els.length, 8000);
    const ctx = new Map(); // element -> "dark" | "keep"
    ctx.set(body, "dark");
    for (let i = 0; i < n; i++) {
      const e = els[i];
      const parentCtx = ctx.get(e.parentElement) || "dark";
      if (parentCtx === "keep") { ctx.set(e, "keep"); continue; }
      const cs = getComputedStyle(e);
      let mine = parentCtx;

      if (cs.backgroundImage && cs.backgroundImage.startsWith("url(")) {
        mine = "keep";
      } else {
        const bgc = C.parse(cs.backgroundColor);
        if (bgc && bgc[3] > 0.05) {
          const m = C.bg(bgc);
          if (m != null) setFix(e, "background-color", m);
          else mine = "keep"; // brand color block, button, or already-dark surface
        }
      }
      ctx.set(e, mine);
      if (mine === "keep") continue;

      if (e.tagName === "IMG") {
        treatImage(e);
        continue;
      }
      const c = C.parse(cs.color);
      const fc = c && C.fg(c);
      if (fc) setFix(e, "color", fc);
      for (const side of BORDER_SIDES) {
        if (parseFloat(cs[`border-${side}-width`]) > 0) {
          const bc = C.parse(cs[`border-${side}-color`]);
          const m = bc && C.border(bc);
          if (m) setFix(e, `border-${side}-color`, m);
        }
      }
    }
  }

  // Gmail proxies email images and keeps the original URL after "#".
  const OPAQUE_EXT = /\.(jpe?g)(?:$|[?#])/i;
  function originalSrc(img) {
    const src = img.currentSrc || img.src || "";
    const hash = src.indexOf("#");
    return hash >= 0 ? src.slice(hash + 1) : src;
  }

  // JPEGs can't be transparent: leave them. Anything else gets a light plate
  // until the background worker has looked at it, then either: dark ink on
  // transparency -> flipped to light; light or opaque -> left alone.
  function treatImage(img) {
    if (OPAQUE_EXT.test(originalSrc(img))) return;
    if (img.width && img.height && img.width * img.height < 400) return; // spacers, pixels
    img.setAttribute("data-gg-plate", "");
    const src = img.currentSrc || img.src;
    if (!src.startsWith("https:") || !globalThis.chrome?.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: "gg-img", url: src.split("#")[0] }).then((info) => {
      if (!info || info.error || !img.isConnected || !img.hasAttribute("data-gg-plate")) return;
      if (info.clear < 0.02) img.removeAttribute("data-gg-plate"); // opaque
      else if (info.lum < 0.4) img.setAttribute("data-gg-plate", "invert"); // dark logo
      else img.removeAttribute("data-gg-plate"); // light/colored on transparency
    }, () => {});
  }

  // Per-email choice (this session) and per-sender choice (saved).
  const messageChoice = new Map(); // message id -> "original" | "dark"

  function senderOf(msg) {
    return msg.querySelector("[email]")?.getAttribute("email")?.toLowerCase() || null;
  }

  function choiceFor(msg) {
    const id = msg.getAttribute("data-message-id");
    if (messageChoice.has(id)) return messageChoice.get(id);
    const sender = senderOf(msg);
    return (sender && settings.senders?.[sender]) || null;
  }

  function decideKind(body, choice) {
    if (choice === "original") return "rich";
    const rich = isRich(body);
    if (!rich) return "plain";
    if (isDarkDesigned(body)) return "native";
    if (choice === "dark") return "dark";
    if (settings.email === "light" || settings.email === "paper") return "rich";
    if (settings.email === "invert") return "invert";
    return "dark";
  }

  function processBody(msg, body) {
    const sig = String(body.getElementsByTagName("*").length);
    const choice = choiceFor(msg);
    const want = sig + "|" + (choice || "");
    if (body.getAttribute("data-gg-sig") === want && body.hasAttribute("data-gg-body")) {
      // Gmail may have re-rendered around the body; put the controls back.
      const prev = body.previousElementSibling;
      if (!prev || !prev.hasAttribute("data-gg-ui")) ensureMessageUi(msg, body, body.getAttribute("data-gg-body"));
      return;
    }
    revertFixes(body);
    const kind = decideKind(body, choice);
    body.setAttribute("data-gg-body", kind);
    body.setAttribute("data-gg-sig", want);
    if (kind === "plain") fixPlain(body);
    else if (kind === "dark") fixDark(body);
    ensureMessageUi(msg, body, kind);
  }

  function resetBodies() {
    for (const b of document.querySelectorAll("[data-gg-body]")) {
      revertFixes(b);
      b.removeAttribute("data-gg-body");
      b.removeAttribute("data-gg-sig");
    }
  }

  // The small "View original / Always for this sender" controls above each
  // message body. Built with DOM APIs (no innerHTML) and kept outside the
  // body so it never ends up in replies or forwards.
  function ensureMessageUi(msg, body, kind) {
    let ui = body.previousElementSibling;
    if (!ui || !ui.hasAttribute("data-gg-ui")) {
      ui = document.createElement("div");
      ui.setAttribute("data-gg-ui", "");
      const view = document.createElement("button");
      view.type = "button";
      view.setAttribute("data-gg-action", "view");
      const always = document.createElement("button");
      always.type = "button";
      always.setAttribute("data-gg-action", "always");
      ui.append(view, always);
      ui.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const btn = ev.target.closest("button[data-gg-action]");
        if (btn) onUiAction(msg, btn.getAttribute("data-gg-action"));
      });
      body.before(ui);
    }
    const showingOriginal = kind === "rich";
    const sender = senderOf(msg);
    const saved = sender && settings.senders?.[sender];
    const [view, always] = ui.children;
    view.textContent = showingOriginal ? "View in dark" : "View original";
    view.setAttribute("aria-label", showingOriginal ? "Show this email in dark colors" : "Show this email in its original colors");
    always.hidden = !sender;
    always.textContent = saved ? `Always ${saved === "original" ? "original" : "dark"} for this sender ✓` : "Always for this sender";
    always.setAttribute("aria-pressed", String(!!saved));
    always.title = sender ? `Remember for ${sender}` : "";
    ui.setAttribute("data-gg-kind", kind);
  }

  function onUiAction(msg, action) {
    const id = msg.getAttribute("data-message-id");
    const body = findBody(msg);
    if (!body) return;
    const showingOriginal = body.getAttribute("data-gg-body") === "rich";
    if (action === "view") {
      messageChoice.set(id, showingOriginal ? "dark" : "original");
    } else if (action === "always") {
      const sender = senderOf(msg);
      if (!sender) return;
      const senders = { ...(settings.senders || {}) };
      if (senders[sender]) delete senders[sender];
      else senders[sender] = showingOriginal ? "original" : "dark";
      settings.senders = senders;
      messageChoice.delete(id);
      globalThis.chrome?.storage?.sync?.set({ senders });
    }
    body.removeAttribute("data-gg-sig");
    processBody(msg, body);
  }

  // ------------------------------------------------------ tagging loop

  function tag() {
    if (!active || !document.body) return;
    setTag("data-gg-panel", findPanel());
    findWallpaper();
    trackChrome();
    tagRows();
    let reading = false;
    for (const msg of document.querySelectorAll("[data-message-id]")) {
      reading = true;
      const body = findBody(msg);
      if (body) processBody(msg, body);
    }
    root.toggleAttribute("data-gg-reading", reading);
  }

  let tagTimer = 0;
  function scheduleTag(fast) {
    if (IS_FRAME) return; // widgets only need the color rewrite
    if (fast) {
      clearTimeout(tagTimer);
      tagTimer = 0;
      requestAnimationFrame(tag);
      return;
    }
    if (tagTimer) return;
    tagTimer = setTimeout(() => {
      tagTimer = 0;
      tag();
    }, 60);
  }

  const observer = new MutationObserver((muts) => {
    if (!active) return;
    let sheets = false, fast = false, any = false, navMoved = false;
    const nav = document.querySelector('[role="navigation"]');
    for (const m of muts) {
      const t = m.target;
      if (nav && t.nodeType === 1 && (t.contains(nav) || nav.contains(t))) navMoved = true;
      if (t.nodeType === 1 && t.closest("[data-gg-body], [data-gg-ui]")) {
        // Content changing inside an already-processed body still needs a re-check.
        if (m.type === "childList") { any = true; fast = true; }
        continue;
      }
      any = true;
      for (const n of m.addedNodes) {
        if ((n.nodeName === "STYLE" || n.nodeName === "LINK") && !n.id?.startsWith("gg-")) sheets = true;
        else if (n.nodeType === 1 && (n.matches?.("[data-message-id]") || n.querySelector?.("[data-message-id]"))) fast = true;
      }
    }
    // The nav sliding out must get its backing before the next paint.
    if (navMoved) trackChrome();
    if (sheets) scheduleSheets();
    if (any) scheduleTag(fast);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-checked"] });

  addEventListener("load", () => { scheduleSheets(); scheduleTag(); });
  addEventListener("resize", () => { wallEls = []; scheduleTag(); });
  addEventListener("hashchange", () => scheduleTag(true));

  // ------------------------------------------------------ health check

  // If Gmail changes enough that the dark styles can't be built, pause
  // instead of leaving light text on white. The popup shows the result.
  function healthCheck() {
    if (!active) return;
    const health = {
      at: Date.now(),
      rules: totalRules,
      panel: !!document.querySelector("[data-gg-panel]"),
      main: !!document.querySelector('[role="main"]'),
      messages: document.querySelectorAll("[data-message-id]").length,
      bodies: document.querySelectorAll("[data-gg-body]").length,
      paused: false,
    };
    if (health.main && health.rules < 300) {
      health.paused = true;
      paused = true;
      console.warn(LOG, "Gmail's styles couldn't be converted; pausing dark mode", health);
      update();
    } else if (!health.panel || health.bodies < health.messages) {
      console.warn(LOG, "some parts of Gmail weren't recognized", health);
    }
    globalThis.chrome?.storage?.local?.set({ health });
  }
  if (!IS_FRAME) setTimeout(healthCheck, 12000);

  // ------------------------------------------------------ start

  for (const mq of [systemDark, moreContrast, reduceTransparency, reduceMotion, forcedColors]) mq.addEventListener("change", update);
  addEventListener("beforeprint", () => { printing = true; update(); });
  addEventListener("afterprint", () => { printing = false; update(); });
  update();

  if (globalThis.chrome?.storage?.sync) {
    Promise.all([
      chrome.storage.sync.get(DEFAULTS),
      chrome.storage.local.get({ customWall: null, customWallInfo: null, liveTheme: null }),
    ]).then(([s, l]) => {
      settings = { ...DEFAULTS, ...s };
      custom = { url: l.customWall, info: l.customWallInfo };
      liveTheme = l.liveTheme;
      update();
      booted = true;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") {
        for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue ?? DEFAULTS[k];
      } else if (area === "local") {
        if (changes.customWall) custom.url = changes.customWall.newValue || null;
        if (changes.customWallInfo) custom.info = changes.customWallInfo.newValue || null;
        if (changes.liveTheme && IS_FRAME) {
          liveTheme = changes.liveTheme.newValue || null;
          applyVars();
          return;
        }
        if (!changes.customWall && !changes.customWallInfo) return;
      }
      update();
    });
  } else {
    booted = true;
  }
})();
