/* eslint-env browser */
/**
 * icons.js — inline SVG icon registry (CSP-safe, zero dependencies).
 *
 * WHY THIS EXISTS
 * ---------------
 * The UI used to draw every glyph with an emoji character. The product font
 * stack has no emoji coverage, so users saw empty boxes (see docs/uiux
 * screenshots). Emoji also cannot inherit `currentColor`, and their advance
 * width is font-dependent, which made icon buttons jitter.
 *
 * Every icon here is a 24x24 viewBox, stroke-only, `currentColor` outline in
 * the Lucide visual language. They inherit text colour, scale with `size`,
 * and are `aria-hidden` because they are always decorative (the accessible
 * name lives on the surrounding button/label).
 *
 * LOAD ORDER: this file MUST be the first front-end script in index.html, so
 * that every later module can call `window.Icons.*` at definition time.
 *
 * CONTRACT (guarded by tests/unit/icons.test.ts):
 *   - no <script>, no url(), no external references — CSP `script-src 'self'`
 *   - stroke="currentColor" fill="none" on the root, aria-hidden="true"
 *   - every name referenced from any consumer module must exist here
 *   - every action id in ACTION_CATALOG must map to a real (non-`dot`) icon
 */
(function () {
  'use strict';

  /**
   * Registry. Each entry is an array of SVG child fragments (already
   * serialised) that live inside a shared 24x24 root element.
   * Keep alphabetical so lookups by eye stay cheap.
   */
  var P = {
    'alert-circle': ['<circle cx="12" cy="12" r="9"/>', '<path d="M12 8v5"/>', '<path d="M12 16.5h.01"/>'],
    'alert-triangle': ['<path d="M10.3 4.1a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3z"/>', '<path d="M12 9.5v4"/>', '<path d="M12 17h.01"/>'],
    'arrow-down': ['<path d="M12 4v15"/>', '<path d="m6 13 6 6 6-6"/>'],
    'arrow-up': ['<path d="M12 20V5"/>', '<path d="m6 11 6-6 6 6"/>'],
    'arrows-vertical': ['<path d="M12 3v18"/>', '<path d="m8 7 4-4 4 4"/>', '<path d="m8 17 4 4 4-4"/>'],
    'bar-chart': ['<path d="M4 20V10"/>', '<path d="M10 20V4"/>', '<path d="M16 20v-7"/>', '<path d="M21.5 20h-19"/>'],
    bell: ['<path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5z"/>', '<path d="M13.7 19.5a2 2 0 0 1-3.4 0"/>'],
    'book-open': ['<path d="M12 7.5v13"/>', '<path d="M2.5 5h5.5a3.5 3.5 0 0 1 3.5 3.5v10a2.5 2.5 0 0 0-2.5-2.5H2.5z"/>', '<path d="M21.5 5H16a3.5 3.5 0 0 0-3.5 3.5v10a2.5 2.5 0 0 1 2.5-2.5h6.5z"/>'],
    braces: ['<path d="M8.5 3.5H7.5a2 2 0 0 0-2 2v4.5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4.5a2 2 0 0 0 2 2h1"/>', '<path d="M15.5 3.5h1a2 2 0 0 1 2 2v4.5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4.5a2 2 0 0 1-2 2h-1"/>'],
    briefcase: ['<rect x="2.5" y="7" width="19" height="13" rx="2"/>', '<path d="M9 7V5.4A1.4 1.4 0 0 1 10.4 4h3.2A1.4 1.4 0 0 1 15 5.4V7"/>', '<path d="M2.5 12.5h19"/>'],
    calendar: ['<rect x="3" y="5" width="18" height="16" rx="2"/>', '<path d="M16 3v4"/>', '<path d="M8 3v4"/>', '<path d="M3 10.5h18"/>'],
    camera: ['<path d="M4 7h2.6l1.7-2.6h7.4L17.4 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>', '<circle cx="12" cy="13.5" r="3.6"/>'],
    check: ['<path d="M20 6 9 17l-5-5"/>'],
    'check-circle': ['<circle cx="12" cy="12" r="9"/>', '<path d="m8.5 12.2 2.4 2.4 4.6-5"/>'],
    'chevron-down': ['<path d="m6 9 6 6 6-6"/>'],
    'chevron-left': ['<path d="m15 18-6-6 6-6"/>'],
    'chevron-right': ['<path d="m9 18 6-6-6-6"/>'],
    'chevron-up': ['<path d="m18 15-6-6-6 6"/>'],
    clipboard: ['<rect x="8.5" y="3" width="7" height="4" rx="1"/>', '<path d="M15.5 5H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2.5"/>'],
    clock: ['<circle cx="12" cy="12" r="9"/>', '<path d="M12 7v5.2l3.4 2"/>'],
    cookie: ['<path d="M12 3a9 9 0 1 0 9 9 3.6 3.6 0 0 1-4.6-4.5A3.6 3.6 0 0 1 12 3z"/>', '<circle cx="8.8" cy="10.6" r=".8" fill="currentColor"/>', '<circle cx="12.2" cy="15.2" r=".8" fill="currentColor"/>', '<circle cx="15.6" cy="12.8" r=".8" fill="currentColor"/>'],
    copy: ['<rect x="8" y="8" width="13" height="13" rx="2"/>', '<path d="M5 15.5H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10.5a1 1 0 0 1 1 1v1"/>'],
    'corner-down-left': ['<path d="M20 4v7a4 4 0 0 1-4 4H5"/>', '<path d="m9 11-4 4 4 4"/>'],
    database: ['<ellipse cx="12" cy="6" rx="8" ry="3"/>', '<path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/>', '<path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>'],
    dot: ['<circle cx="12" cy="12" r="3.6"/>'],
    download: ['<path d="M21 15.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3.5"/>', '<path d="m7.5 10.5 4.5 4.5 4.5-4.5"/>', '<path d="M12 15V3"/>'],
    eye: ['<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/>', '<circle cx="12" cy="12" r="2.9"/>'],
    'eye-off': ['<path d="M10.7 6c.4-.1.9-.2 1.3-.2 6 0 9.5 6.2 9.5 6.2s-1 1.8-2.7 3.4"/>', '<path d="M6.6 7.9C4.1 9.6 2.5 12 2.5 12S6 18.2 12 18.2c1.6 0 3-.4 4.2-1"/>', '<path d="M10 10a2.9 2.9 0 0 0 4 4"/>', '<path d="m3.5 3.5 17 17"/>'],
    'file-text': ['<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>', '<path d="M14 3v5h5"/>', '<path d="M9 13.5h6"/>', '<path d="M9 17h4"/>'],
    filter: ['<path d="M3 5.5h18l-7 8.2V20l-4-2.2v-4.1z"/>'],
    folder: ['<path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.6H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'],
    frame: ['<path d="M4 8h16"/>', '<path d="M4 16h16"/>', '<path d="M8 4v16"/>', '<path d="M16 4v16"/>'],
    gauge: ['<path d="M3.6 17.5a9 9 0 1 1 16.8 0"/>', '<path d="m12 14 4-4"/>', '<circle cx="12" cy="14.4" r="1.3" fill="currentColor"/>'],
    'git-branch': ['<path d="M6 8.5v10"/>', '<circle cx="18" cy="6" r="2.6"/>', '<circle cx="6" cy="5.6" r="2.6"/>', '<circle cx="6" cy="18.6" r="2.6"/>', '<path d="M18 8.6a7.4 7.4 0 0 1-7.4 7.4H8.6"/>'],
    globe: ['<circle cx="12" cy="12" r="9"/>', '<path d="M3 12h18"/>', '<path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>'],
    grab: ['<path d="M8 12V7.2a1.5 1.5 0 0 1 3 0V11"/>', '<path d="M11 11V5.6a1.5 1.5 0 0 1 3 0V11"/>', '<path d="M14 11.2V7.4a1.5 1.5 0 0 1 3 0V13"/>', '<path d="M17 12.6A5.4 5.4 0 0 1 11.6 18h-.4a6 6 0 0 1-6-6v-1.6a1.5 1.5 0 0 1 3 0V12"/>'],
    grid: ['<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/>', '<rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/>', '<rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/>', '<rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>'],
    hand: ['<path d="M18 11.5V6.2a1.5 1.5 0 0 0-3 0V11"/>', '<path d="M15 11V4.6a1.5 1.5 0 0 0-3 0V11"/>', '<path d="M12 11V5.6a1.5 1.5 0 0 0-3 0V13"/>', '<path d="M9 13V10.4a1.5 1.5 0 0 0-3 0V14a7 7 0 0 0 7 7h.6a5.4 5.4 0 0 0 5.4-5.4V11.5"/>'],
    'help-circle': ['<circle cx="12" cy="12" r="9"/>', '<path d="M9.6 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2-2.5 3.6"/>', '<path d="M12 17.3h.01"/>'],
    history: ['<path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.5L3 8.2"/>', '<path d="M3 4v4.4h4.4"/>', '<path d="M12 8v4.6l3.2 1.9"/>'],
    home: ['<path d="m3 10.2 9-7 9 7V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', '<path d="M9.5 21v-6.5h5V21"/>'],
    hourglass: ['<path d="M7 3h10"/>', '<path d="M7 21h10"/>', '<path d="M17 3v3.3a5 5 0 0 1-2.1 4.1L12 12l-2.9 1.6A5 5 0 0 0 7 17.7V21"/>', '<path d="M7 3v3.3a5 5 0 0 0 2.1 4.1L12 12l2.9 1.6a5 5 0 0 1 2.1 4.1V21"/>'],
    'image-frame': ['<rect x="3" y="4" width="18" height="16" rx="2"/>', '<path d="m5.5 17.5 4.2-4.2 2.8 2.8 3.2-3.2 3.3 3.3"/>', '<circle cx="9" cy="9" r="1.4"/>'],
    infinity: ['<path d="M12 12c-1.9-2.6-3.4-3.9-5.4-3.9a3.9 3.9 0 0 0 0 7.8c2 0 3.5-1.3 5.4-3.9z"/>', '<path d="M12 12c1.9 2.6 3.4 3.9 5.4 3.9a3.9 3.9 0 0 0 0-7.8c-2 0-3.5 1.3-5.4 3.9z"/>'],
    keyboard: ['<rect x="2.5" y="6" width="19" height="12" rx="2"/>', '<path d="M6.5 10h.01"/>', '<path d="M10 10h.01"/>', '<path d="M13.5 10h.01"/>', '<path d="M17.5 10h.01"/>', '<path d="M8 14h8"/>'],
    layers: ['<path d="m12 3 9 4.6-9 4.6-9-4.6z"/>', '<path d="m3 12.5 9 4.6 9-4.6"/>', '<path d="m3 16.9 9 4.6 9-4.6"/>'],
    layout: ['<rect x="3" y="4" width="7" height="7" rx="1.5"/>', '<rect x="14" y="4" width="7" height="7" rx="1.5"/>', '<rect x="3" y="15" width="7" height="5" rx="1.5"/>', '<rect x="14" y="15" width="7" height="5" rx="1.5"/>'],
    link: ['<path d="M10.6 13.4a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.9 6.2"/>', '<path d="M13.4 10.6a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.5-1.5"/>'],
    lock: ['<rect x="4" y="10" width="16" height="11" rx="2"/>', '<path d="M8 10V7a4 4 0 0 1 8 0v3"/>'],
    map: ['<path d="m3 6.6 6-2.6 6 2.6 6-2.6v13l-6 2.6-6-2.6-6 2.6z"/>', '<path d="M9 4v13"/>', '<path d="M15 6.6v13"/>'],
    maximize: ['<path d="M8 3H5a2 2 0 0 0-2 2v3"/>', '<path d="M16 3h3a2 2 0 0 1 2 2v3"/>', '<path d="M21 16v3a2 2 0 0 1-2 2h-3"/>', '<path d="M3 16v3a2 2 0 0 0 2 2h3"/>'],
    'message-square': ['<path d="M21 15.4a2 2 0 0 1-2 2H8.4L4 21.5V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>'],
    minus: ['<path d="M5 12h14"/>'],
    'more-vertical': ['<circle cx="12" cy="5" r="1.5" fill="currentColor"/>', '<circle cx="12" cy="12" r="1.5" fill="currentColor"/>', '<circle cx="12" cy="19" r="1.5" fill="currentColor"/>'],
    'mouse-pointer': ['<path d="m3.5 3.5 7 17 2.5-7.4 7.4-2.5z"/>'],
    'mouse-pointer-2': ['<path d="m3.5 3.5 6.4 15.6 2.3-6.8 6.8-2.3z"/>', '<path d="M18 3.5v3"/>', '<path d="M22 8h-3"/>', '<path d="m21.2 4.8-2.1 2.1"/>'],
    move: ['<path d="M12 3v18"/>', '<path d="M3 12h18"/>', '<path d="m9 6 3-3 3 3"/>', '<path d="m9 18 3 3 3-3"/>', '<path d="m6 9-3 3 3 3"/>', '<path d="m18 9 3 3-3 3"/>'],
    'octagon-alert': ['<path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6z"/>', '<path d="M12 8v5"/>', '<path d="M12 16.4h.01"/>'],
    palette: ['<path d="M12 21a9 9 0 1 1 9-9c0 1.7-1.4 3-3.1 3H16a2.1 2.1 0 0 0-1.5 3.5A2.1 2.1 0 0 1 12 21z"/>', '<circle cx="7.6" cy="12.6" r="1.1" fill="currentColor"/>', '<circle cx="9.6" cy="8.4" r="1.1" fill="currentColor"/>', '<circle cx="14.2" cy="7.6" r="1.1" fill="currentColor"/>', '<circle cx="17.2" cy="10.6" r="1.1" fill="currentColor"/>'],
    'panel-left': ['<rect x="3" y="4" width="18" height="16" rx="2"/>', '<path d="M9.2 4v16"/>'],
    paperclip: ['<path d="M20.9 11.6 12.3 20.2a5.4 5.4 0 0 1-7.6-7.6l8.6-8.6a3.6 3.6 0 0 1 5.1 5.1l-8.6 8.6a1.8 1.8 0 0 1-2.5-2.5l7.9-7.9"/>'],
    pencil: ['<path d="M16.8 3.6a2.1 2.1 0 0 1 3 3L7.4 19 3 20.5 4.5 16z"/>', '<path d="m14.4 6.2 3.4 3.4"/>'],
    pin: ['<path d="M12 16.5V22"/>', '<path d="M9 3h6l-1 5 3.6 3.6v2.2H6.4v-2.2L10 8z"/>'],
    play: ['<path d="m7 4.2 12 7.8-12 7.8z"/>'],
    'play-circle': ['<circle cx="12" cy="12" r="9"/>', '<path d="m10 8.2 6 3.8-6 3.8z"/>'],
    plus: ['<path d="M12 5v14"/>', '<path d="M5 12h14"/>'],
    power: ['<path d="M12 3v9"/>', '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'],
    repeat: ['<path d="m17 2 4 4-4 4"/>', '<path d="M3 11.5V10a4 4 0 0 1 4-4h14"/>', '<path d="m7 22-4-4 4-4"/>', '<path d="M21 12.5V14a4 4 0 0 1-4 4H3"/>'],
    rocket: ['<path d="M12 2.5s4.6 2.2 4.6 8.2c0 3-1.5 5.3-1.5 5.3H8.9s-1.5-2.3-1.5-5.3C7.4 4.7 12 2.5 12 2.5z"/>', '<path d="M9 16.5s-3 1.1-3 4.2h12c0-3.1-3-4.2-3-4.2"/>', '<circle cx="12" cy="9.4" r="1.7"/>'],
    'rotate-ccw': ['<path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.5L3 8.2"/>', '<path d="M3 4v4.4h4.4"/>'],
    'rotate-cw': ['<path d="M20.8 12a8.8 8.8 0 1 1-2.9-6.5L21 8.2"/>', '<path d="M21 4v4.4h-4.4"/>'],
    save: ['<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>', '<path d="M17 21v-8H7v8"/>', '<path d="M7.5 3v5H15"/>'],
    search: ['<circle cx="11" cy="11" r="7"/>', '<path d="m20.5 20.5-4-4"/>'],
    send: ['<path d="m21.5 2.5-7 19-4-8.5-8.5-4z"/>', '<path d="M21.5 2.5 10.5 13"/>'],
    settings: ['<circle cx="12" cy="12" r="3"/>', '<path d="M19.6 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.3a1.7 1.7 0 1 1-3.4 0V20a1.6 1.6 0 0 0-1.1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3.5a1.7 1.7 0 1 1 0-3.4h.3a1.6 1.6 0 0 0 1.5-1.1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.6 1.6 0 0 0 1.8.3H9.4A1.6 1.6 0 0 0 10.4 4V3.7a1.7 1.7 0 1 1 3.4 0V4a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.3a1.7 1.7 0 1 1 0 3.4H21a1.6 1.6 0 0 0-1.4 1z"/>'],
    shield: ['<path d="M12 3.2 20 6v5.9c0 4.5-3.2 8.3-8 9.6-4.8-1.3-8-5.1-8-9.6V6z"/>'],
    // `Admin` in the locked launcher/nav is a shield with a CHECK inside
    // (docs/uiux/shell-editor-launcher-menu.webp). Plain `shield` stays because
    // ACTION_ICONS aliases `try` to it.
    'shield-check': ['<path d="M12 3.2 20 6v5.9c0 4.5-3.2 8.3-8 9.6-4.8-1.3-8-5.1-8-9.6V6z"/>',
      '<path d="m9.2 11.9 2 2 3.6-3.7"/>'],
    shuffle: ['<path d="M16.5 3.5H21v4.5"/>', '<path d="M21 3.5 3.5 21"/>', '<path d="M21 16v4.5h-4.5"/>', '<path d="m14.5 14.5 6.5 6"/>', '<path d="m3.5 3.5 5 4.6"/>'],
    sitemap: ['<rect x="9" y="3" width="6" height="5" rx="1.2"/>', '<rect x="2" y="16" width="6" height="5" rx="1.2"/>', '<rect x="16" y="16" width="6" height="5" rx="1.2"/>', '<path d="M12 8v3.8"/>', '<path d="M5 16v-4.2h14V16"/>'],
    sliders: ['<path d="M4 7h7.5"/>', '<path d="M16.5 7H20"/>', '<circle cx="14" cy="7" r="2.2"/>', '<path d="M4 12h3.5"/>', '<path d="M12.5 12H20"/>', '<circle cx="10" cy="12" r="2.2"/>', '<path d="M4 17h9.5"/>', '<path d="M18.5 17H20"/>', '<circle cx="16" cy="17" r="2.2"/>'],
    sparkles: ['<path d="m11 3.2 1.7 4.4 4.4 1.7-4.4 1.7L11 15.4 9.3 11 4.9 9.3l4.4-1.7z"/>', '<path d="m18 14.6.85 2.05 2.05.85-2.05.85L18 20.4l-.85-2.05L15.1 17.5l2.05-.85z"/>'],
    square: ['<rect x="4" y="4" width="16" height="16" rx="2.5"/>'],
    star: ['<path d="m12 3.3 2.7 5.5 6 .9-4.3 4.3 1 6-5.4-2.9-5.4 2.9 1-6L3.3 9.7l6-.9z"/>'],
    'square-check': ['<rect x="4" y="4" width="16" height="16" rx="2.5"/>', '<path d="m8.4 12.2 2.4 2.4 4.8-5.2"/>'],
    'square-x': ['<rect x="4" y="4" width="16" height="16" rx="2.5"/>', '<path d="m9.2 9.2 5.6 5.6"/>', '<path d="m14.8 9.2-5.6 5.6"/>'],
    'stop-circle': ['<circle cx="12" cy="12" r="9"/>', '<rect x="9" y="9" width="6" height="6" rx="1.2"/>'],
    tag: ['<path d="M20.6 12.6 12.6 20.6a2 2 0 0 1-2.8 0l-6.4-6.4a2 2 0 0 1-.6-1.4V4.8a2 2 0 0 1 2-2h8a2 2 0 0 1 1.4.6l6.4 6.4a2 2 0 0 1 0 2.8z"/>', '<circle cx="7.6" cy="7.6" r="1.4"/>'],
    target: ['<circle cx="12" cy="12" r="9"/>', '<circle cx="12" cy="12" r="4.8"/>', '<circle cx="12" cy="12" r="1.3" fill="currentColor"/>'],
    terminal: ['<rect x="2.5" y="4" width="19" height="16" rx="2"/>', '<path d="m7 10 2.6 2.6L7 15.2"/>', '<path d="M13.2 15.6h4.2"/>'],
    trash: ['<path d="M4 6.8h16"/>', '<path d="M9 6.8V5a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 5v1.8"/>', '<path d="M6.2 6.8 7.2 19.6a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9l1-12.8"/>', '<path d="M10.2 11v6"/>', '<path d="M13.8 11v6"/>'],
    upload: ['<path d="M21 15.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3.5"/>', '<path d="m7.5 8 4.5-4.5L16.5 8"/>', '<path d="M12 3.5v12"/>'],
    user: ['<circle cx="12" cy="8" r="3.8"/>', '<path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>'],
    users: ['<circle cx="9.5" cy="8" r="3.5"/>', '<path d="M3 20.5a6.5 6.5 0 0 1 13 0"/>', '<path d="M16.2 4.8a3.5 3.5 0 0 1 0 6.6"/>', '<path d="M18 14.6a6.5 6.5 0 0 1 3 5.9"/>'],
    variable: ['<path d="M8.2 3.2a13 13 0 0 0 0 17.6"/>', '<path d="M15.8 3.2a13 13 0 0 1 0 17.6"/>', '<path d="m9.6 9.6 4.8 4.8"/>', '<path d="m14.4 9.6-4.8 4.8"/>'],
    wand: ['<path d="M3.2 20.8 14 10"/>', '<path d="m12.2 8.2 3.6 3.6"/>', '<path d="M17.5 3v3"/>', '<path d="M21.5 8.5h-3"/>', '<path d="m21 4-2.1 2.1"/>'],
    webhook: ['<path d="M17.6 16.9h-5.7c-1 0-1.9.9-2.4 1.8a3.9 3.9 0 0 1-7.5-1.7c0-.7.2-1.4.6-2"/>', '<path d="m6.2 16.9 3-5.6c.5-.9.1-2.1-.5-3a3.9 3.9 0 1 1 6.7-3.9"/>', '<path d="m12 6.2 3 5.6c.5.9 1.7 1.2 2.8 1.2a3.9 3.9 0 0 1 0 7.8"/>'],
    x: ['<path d="m6 6 12 12"/>', '<path d="M18 6 6 18"/>'],
    'x-circle': ['<circle cx="12" cy="12" r="9"/>', '<path d="m9.2 9.2 5.6 5.6"/>', '<path d="m14.8 9.2-5.6 5.6"/>'],
    zap: ['<path d="m13 2.5-8.5 11.6H11l-1 7.9 8.5-11.6H12z"/>'],
  };

  /**
   * Action id -> registry name. Kept in sync with public/js/actions.js by
   * tests/unit/icons.test.ts (every catalog id must resolve to a real icon).
   */
  var ACTION_ICONS = {
    __start__: 'play-circle',
    // navigation
    goto: 'globe',
    wait: 'clock',
    launch: 'rocket',
    'launch-browser': 'rocket',
    'wait-element': 'eye',
    delay: 'hourglass',
    'switch-frame': 'image-frame',
    'switch-tab': 'layers',
    'close-tab': 'square-x',
    'close-browser': 'power',
    close: 'power',
    'handle-dialog': 'message-square',
    // interaction
    click: 'mouse-pointer',
    dblclick: 'mouse-pointer-2',
    hover: 'hand',
    focus: 'target',
    'mouse-move': 'move',
    'drag-drop': 'grab',
    scroll: 'arrows-vertical',
    fill: 'pencil',
    type: 'keyboard',
    press: 'corner-down-left',
    select: 'chevron-down',
    check: 'square-check',
    uncheck: 'square',
    upload: 'paperclip',
    // data
    extract: 'download',
    'extract-data': 'database',
    'parse-json': 'braces',
    'export-data': 'save',
    screenshot: 'camera',
    download: 'arrow-down',
    attribute: 'tag',
    variable: 'variable',
    cookie: 'cookie',
    clipboard: 'clipboard',
    notification: 'bell',
    log: 'file-text',
    'http-request': 'globe',
    'remove-element': 'trash',
    'add-style': 'palette',
    // flow control
    if: 'git-branch',
    switch: 'shuffle',
    loop: 'rotate-cw',
    foreach: 'repeat',
    while: 'infinity',
    try: 'shield',
    stop_and_error: 'octagon-alert',
    // triggers
    trigger_manual: 'play-circle',
    trigger_webhook: 'webhook',
    trigger_schedule: 'calendar',
    trigger_telegram: 'send',
  };

  /** @returns {boolean} whether `name` is a real registry entry. */
  function has(name) { return Object.prototype.hasOwnProperty.call(P, name); }

  /** @returns {string[]} every registered icon name (sorted). */
  function names() { return Object.keys(P).sort(); }

  /**
   * Serialise an icon to an SVG string.
   * @param {string} name registry key; unknown names degrade to `dot`
   * @param {{size?:number, cls?:string, stroke?:number}} [opts]
   */
  function svg(name, opts) {
    opts = opts || {};
    var body = P[name] || P.dot;
    var size = opts.size || 16;
    var cls = 'ic' + (opts.cls ? ' ' + opts.cls : '');
    return '<svg class="' + cls + '" width="' + size + '" height="' + size + '"' +
      ' viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="' + (opts.stroke || 1.7) + '"' +
      ' stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true" focusable="false">' + body.join('') + '</svg>';
  }

  /** Icon for an ACTION_CATALOG id (falls back to `dot`). */
  function action(actionId, opts) { return svg(ACTION_ICONS[actionId] || 'dot', opts); }

  /** DOM-node flavour of {@link svg}, for imperative call sites. */
  function el(name, opts) {
    var w = document.createElement('div');
    w.innerHTML = svg(name, opts);
    return w.firstChild;
  }

  /**
   * Declarative hydration for STATIC markup: `data-icon="name"` (plus optional
   * `data-icon-size`). Idempotent — already-hydrated nodes are skipped, so it
   * is safe to call after every route render.
   * @returns {number} how many placeholders were filled
   */
  function hydrate(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-icon]:not([data-icon-done])');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var size = parseInt(n.getAttribute('data-icon-size'), 10);
      n.innerHTML = svg(n.getAttribute('data-icon'), { size: size || 16 });
      n.setAttribute('data-icon-done', '1');
    }
    return nodes.length;
  }

  window.Icons = {
    svg: svg,
    el: el,
    has: has,
    names: names,
    action: action,
    hydrate: hydrate,
    ACTION_ICONS: ACTION_ICONS,
  };

  // Guarded so the module can also be loaded in the DOM-free unit-test shim.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { hydrate(); });
    } else {
      hydrate();
    }
  }
})();
