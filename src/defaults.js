// Shared by the content script, popup and settings page.
(() => {
  const DEFAULTS = {
    mode: "auto", // auto | on | off
    glass: 0.58, // minimum panel tint opacity (raised automatically for contrast)
    blur: 24, // px
    wallDim: 0.62, // wallpaper brightness
    email: "smart", // smart: designed emails go dark | light: designed emails on a light card | invert
    paper: 0.94, // brightness of light-card emails
    warmth: 0, // 0-0.3, warms light-card emails
    accent: "auto", // auto = picked from the wallpaper's color
    tint: true, // tint the glass with the wallpaper's color
    wallpaper: "gmail", // gmail | aurora | dusk | ocean | graphite | custom
    focusRead: true, // push the wallpaper back while a thread is open
    motion: true, // fades and pops (always off with Reduce motion)
    senders: {}, // email address -> "original" | "dark"
  };

  // macOS dark-mode system colors. `link` is a lighter tone that passes
  // 4.5:1 as text on the glass.
  const ACCENTS = {
    // Placeholder colors; content.js derives the real ones from the wallpaper.
    auto: { name: "Match wallpaper", accent: "#0a84ff", link: "#8ec3ff", auto: true },
    blue: { name: "Blue", accent: "#0a84ff", link: "#8ec3ff" },
    purple: { name: "Purple", accent: "#bf5af2", link: "#dca6f8" },
    pink: { name: "Pink", accent: "#ff375f", link: "#ff9fb3" },
    red: { name: "Red", accent: "#ff453a", link: "#ffa39d" },
    orange: { name: "Orange", accent: "#ff9f0a", link: "#ffc77a" },
    yellow: { name: "Yellow", accent: "#ffd60a", link: "#ffe680" },
    green: { name: "Green", accent: "#32d74b", link: "#8de89b" },
    graphite: { name: "Graphite", accent: "#98989d", link: "#c9c9cd" },
  };

  // Built-in wallpapers. `stats` are pre-measured brightness values
  // (0-255) so the glass can be tuned without sampling, `tint` is their color.
  const WALLPAPERS = {
    aurora: {
      name: "Aurora",
      css:
        "radial-gradient(1200px 800px at 12% 8%, rgba(88,101,242,.32), transparent 60%)," +
        "radial-gradient(1000px 700px at 88% 92%, rgba(20,184,166,.22), transparent 60%)," +
        "radial-gradient(900px 600px at 72% 18%, rgba(168,85,247,.2), transparent 60%),#0b0d12",
      stats: { p90: 52, left: 52, top: 52 },
      tint: [70, 82, 170],
    },
    dusk: {
      name: "Dusk",
      css:
        "radial-gradient(1100px 700px at 80% 0%, rgba(255,120,80,.30), transparent 60%)," +
        "radial-gradient(900px 700px at 10% 100%, rgba(190,60,140,.26), transparent 60%)," +
        "linear-gradient(160deg,#1a1020,#0d0b14)",
      stats: { p90: 60, left: 50, top: 62 },
      tint: [170, 80, 110],
    },
    ocean: {
      name: "Ocean",
      css:
        "radial-gradient(1200px 800px at 20% 10%, rgba(0,150,200,.30), transparent 60%)," +
        "radial-gradient(1000px 800px at 90% 90%, rgba(0,90,160,.30), transparent 60%)," +
        "linear-gradient(180deg,#06131c,#050b12)",
      stats: { p90: 55, left: 55, top: 55 },
      tint: [30, 120, 170],
    },
    graphite: {
      name: "Graphite",
      css: "radial-gradient(1400px 900px at 50% 0%, rgba(255,255,255,.08), transparent 60%),linear-gradient(180deg,#141518,#0c0d0f)",
      stats: { p90: 36, left: 30, top: 38 },
      tint: null,
    },
  };

  globalThis.GG_DEFAULTS = DEFAULTS;
  globalThis.GG_ACCENTS = ACCENTS;
  globalThis.GG_WALLPAPERS = WALLPAPERS;
})();
