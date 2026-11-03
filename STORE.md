# Chrome Web Store submission notes

Copy these into the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Package
Upload `dist/dark-glass-for-gmail-1.0.0.zip`.

## Store listing
- **Name:** Dark Glass for Gmail
- **Summary:** Dark mode for Gmail that follows your system, keeps your theme's wallpaper, and stays readable. Frosted dark glass.
- **Category:** Productivity → Workflow & Planning (or "Accessibility")
- **Language:** English
- **Description:**

  Dark Glass for Gmail turns Gmail dark whenever your computer is in dark mode, without throwing away your Gmail theme. Your background image stays, dimmed behind frosted dark glass panels, menus and dialogs.

  • Follows your system's dark mode automatically (or set it to always / off)
  • Keeps your Gmail theme's wallpaper, or choose a built-in one or your own image
  • Glass thickens automatically over bright wallpapers so text always meets WCAG AA contrast
  • Accent color picked from your wallpaper (or choose one)
  • Designed newsletters are recolored to dark, keeping brand colors and images; switch any email or sender back to original colors with one click
  • Respects Increase contrast, Reduce transparency and Reduce motion
  • Everything runs locally. No data is collected or sent anywhere.

  Not affiliated with Google. Gmail is a trademark of Google LLC.

- **Icon:** `icons/icon128.png`
- **Screenshots:** at least one 1280×800 or 640×400 PNG/JPEG.

## Privacy practices tab
- **Single purpose:** Restyles Gmail into a dark theme that follows the system's dark mode.
- **Permission justifications:**
  - `storage`: saves the user's settings (mode, colors, wallpaper, per-sender choices).
  - `unlimitedStorage`: lets the user's optional custom wallpaper image be stored locally.
  - Host `mail.google.com`: the content script restyles Gmail.
  - Host `contacts.google.com/widget/*`: restyles the contact cards Gmail shows on hover.
  - Hosts `*.googleusercontent.com`, `*.gstatic.com`, `*.google.com/rd-mail-pt/*`: read the brightness and color of images Gmail already displays (the theme wallpaper and email logos) so text contrast and logo visibility can be adjusted. Images are not stored or sent anywhere.
- **Remote code:** No, I am not using remote code.
- **Data usage:** check none of the data types (nothing is collected). Certify the three disclosures.
- **Privacy policy URL:** https://jrundquist.github.io/dark-glass-for-gmail/PRIVACY.html

## Visibility
Distribution → Visibility: **Unlisted** (installable from the link, not searchable).
