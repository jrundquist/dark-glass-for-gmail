// Color parsing and the light -> dark mapping rules.
// Shared by the stylesheet rewriter and the email body fixer.
(() => {
  const NAMED = {
    white: [255, 255, 255, 1],
    black: [0, 0, 0, 1],
    transparent: [0, 0, 0, 0],
  };

  // Matches the color tokens we know how to rewrite inside a CSS value.
  const COLOR_TOKEN = /rgba?\([^()]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:white|black)\b/g;

  function parse(str) {
    if (!str) return null;
    str = str.trim().toLowerCase();
    if (NAMED[str]) return NAMED[str].slice();
    if (str[0] === "#") {
      let h = str.slice(1);
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    const m = str.match(/^rgba?\(([^)]*)\)$/);
    if (!m) return null;
    const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (v) => (v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v));
    let a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const out = [ch(parts[0]), ch(parts[1]), ch(parts[2]), a];
    return out.some(Number.isNaN) ? null : out;
  }

  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r2 = (v) => Math.round(v * 1000) / 1000;
  const hsla = (h, s, l, a) =>
    `hsla(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${r2(a)})`;
  const white = (a) => `rgba(255, 255, 255, ${r2(a)})`;

  // Lowest lightness converted text may get. 0.75 keeps Gmail's gray
  // secondary text above WCAG AA (4.5:1) on the glass; "Increase contrast"
  // raises it.
  let fgFloor = 0.75;
  function setFgFloor(v) {
    const changed = v !== fgFloor;
    fgFloor = v;
    return changed;
  }

  // Text, icons, accents: dark becomes light, hue is kept.
  function fg(c) {
    const [h, s, l] = toHsl(c);
    if (c[3] === 0 || l >= 0.6) return null;
    const nl = clamp(1 - l * 0.85, fgFloor, 0.93);
    return hsla(h, s * 0.85, nl, c[3]);
  }

  // Surfaces. Light surfaces turn into faint white veils so the glass and
  // wallpaper show through. Strong colors (buttons) are left alone.
  function bg(c) {
    const [h, s, l] = toHsl(c);
    const a = c[3];
    if (a < 0.02) return null;
    const neutral = s < 0.2 || l > 0.93;
    if (neutral && l >= 0.8) {
      if (a >= 0.5) return l >= 0.985 ? "transparent" : white(clamp((1 - l) * 1.6, 0.04, 0.14));
      return white(Math.min(a * 0.4, 0.12));
    }
    if (l >= 0.75) return hsla(h, Math.min(s, 0.6), 0.55, 0.22);
    // Hover / pressed state layers are dark at low alpha in a light theme.
    if (l < 0.3 && a <= 0.2) return white(clamp(a * 1.4, 0.04, 0.2));
    return null;
  }

  function border(c) {
    const [, , l] = toHsl(c);
    if (c[3] === 0) return null;
    // Pure white borders only blend a box into a white surface (Chat's
    // message rows): on dark glass they'd show as outlines.
    if (l >= 0.985) return "transparent";
    if (l > 0.75) return white(0.12 * c[3]);
    if (l < 0.3 && c[3] < 0.3) return white(c[3]);
    return fg(c);
  }

  // Text that sits on an accent fill ("on-primary"): needs to go dark.
  function onAccent(c) {
    const [h, , l] = toHsl(c);
    if (l < 0.6) return null;
    return "var(--gg-on-accent)";
  }

  // Shadows: light-theme "shadows" that are really light separator lines
  // become faint white; real (dark) shadows stay.
  function shadow(c) {
    const [, , l] = toHsl(c);
    if (c[3] === 0 || l < 0.6) return null;
    if (l >= 0.985) return "transparent";
    return white(0.08 * c[3]);
  }

  const MAPPERS = { fg, bg, border, onAccent, shadow };

  // Gmail's blue (primary buttons, links, selection, the keyboard-cursor bar,
  // its blue labels) is swapped for the user's accent, so the whole UI
  // follows one color. The accent lives in CSS variables, so changing it
  // needs no rebuild.
  // Light blue "tonal" containers (Track package, Send Mail) become a clear
  // accent tint, and the dark navy text Gmail puts on them becomes the light
  // accent tone (about 6:1 on that tint).
  function accentFor(c, kind) {
    const [h, s, l] = toHsl(c);
    if (h < 198 || h > 228 || s < 0.45 || l > 0.97 || c[3] === 0) return null;
    // Very light blue-grays (#e9eef6, #f0f4f9) are Gmail's neutral surfaces,
    // not its blue: only clearly saturated light blues are accents.
    if (l >= 0.9 && s < 0.7) return null;
    const a = r2(c[3]);
    if (kind === "fg") {
      if (l < 0.05) return null;
      return a === 1 ? "var(--gg-link)" : `rgba(var(--gg-link-rgb), ${a})`;
    }
    if (l < 0.25) return null;
    if (kind === "bg" || kind === "border") {
      return l >= 0.8 ? `rgba(var(--gg-accent-rgb), ${r2(0.32 * a)})` : `rgba(var(--gg-accent-rgb), ${a})`;
    }
    return null;
  }

  // Replace every color token inside a CSS value. Returns null if nothing changed.
  function mapValue(value, kind) {
    const fn = MAPPERS[kind];
    let changed = false;
    const out = value.replace(COLOR_TOKEN, (tok) => {
      const c = parse(tok);
      if (!c) return tok;
      const m = accentFor(c, kind) ?? fn(c);
      if (m == null) return tok;
      changed = true;
      return m;
    });
    return changed ? out : null;
  }

  function luminance(c) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  }

  // WCAG contrast ratio between two opaque colors.
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  globalThis.GGColor = { parse, toHsl, fg, bg, border, onAccent, mapValue, luminance, contrast, setFgFloor };
})();
