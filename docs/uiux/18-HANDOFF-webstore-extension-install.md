# Handoff 18 — Install a Chrome extension from a Web Store link

**Status:** ✅ Implemented
**Mission:** `MISSIONS.md` § 9

---

## 1. What the owner asked for

> «این مشکل رو داشتم و ظاهرا دردسرش زیاده — من فقط نیازه که براش آدرس پلاگین رو بدم
> نصبش کنه خودش … و بتونه پلای‌رایت ازش استفاده کنه»

The Real Chrome panel used to offer exactly two ways to get an extension in:

1. **Upload a `.crx`/`.zip`** — but the Web Store gives you no download button,
   so obtaining the file at all means a third-party CRX-extractor site.
2. **Remote desktop over noVNC** — which needs
   `xvfb x11vnc novnc websockify` installed, and was reported as *stopped*
   with a red "install the virtual display stack" hint.

The ask: paste the store address, let the server do the rest, and have
Playwright drive it.

---

## 2. What it does now

`Real Chrome ▸ Extensions` opens with a URL field:

```
┌─────────────────────────────────────────────┬─────────┐
│ https://chromewebstore.google.com/detail/…  │ Install │
└─────────────────────────────────────────────┴─────────┘
```

Paste → **Install** (or press Enter). The server downloads the signed `.crx`
from Google's own update endpoint, unpacks it, pins its identity and lists it.
Restart the browser and Playwright is running with it.

Accepted inputs — all four resolve to the same extension:

| Input | Works |
|---|---|
| `https://chromewebstore.google.com/detail/j2team-cookies/okpidco…` | ✅ |
| `https://chromewebstore.google.com/detail/okpidco…?utm_source=item-share-cb` | ✅ |
| `https://chrome.google.com/webstore/detail/j2team-cookies/okpidco…?hl=en` | ✅ (legacy host) |
| `okpidcojinmlaakglciglbpcpajaibco` | ✅ (bare id) |

---

## 3. The four traps, and how each is handled

### 3.1 Picking the wrong signing key ⚠️ the subtle one

A store `.crx` is signed **more than once** — by the developer *and* by Google's
publisher key — so its CRX3 header holds several `AsymmetricKeyProof` entries.
Taking the first one produces a perfectly well-formed but **wrong** extension id.

Measured on the owner's extension:

```
proof keys found: 3
crx_id (signed) : okpidcojinmlaakglciglbpcpajaibco
  key[0] len=294 id=lfoeajgcchlidpicbabpmckkejpckcfb
  key[1] len=294 id=okpidcojinmlaakglciglbpcpajaibco   <-- the real one
  key[2] len=91  id=gbphpckglpmphemnalmbpocejhmmjlae
```

`crxPublicKey()` therefore reads `signed_header_data` (protobuf field 10000) for
the authoritative 16-byte `crx_id` and returns **the key that hashes to it**.
When several proofs exist and none is named, it returns `null` rather than
guessing.

### 3.2 The id was tied to the install path

Chrome derives an *unpacked* extension's id from its **absolute directory
path**. Every `chrome-extension://<id>/…` URL saved in a workflow would break
the moment the server was redeployed somewhere else.

Fix: write the signing key into `manifest.json` as `key`. Chrome then derives
the id from the key, so the extension keeps its **official Web Store id**
forever. Verified against a live browser:

```
chrome runtime id : okpidcojinmlaakglciglbpcpajaibco
our extensionId   : okpidcojinmlaakglciglbpcpajaibco
IDS AGREE         : true
```

### 3.3 `manifest.name` is usually not a name

Nearly every store extension localises itself, so the manifest literally says
`"name": "__MSG_appName__"`. `describe()` now resolves placeholders against
`_locales/<default_locale>/messages.json` (falling back to `en`, then to
whatever is shipped), so the panel shows **“J2TEAM Cookies”**.

### 3.4 Two components disagreeing about the id

`RealChrome.loadedExtensions()` computed the id with `unpackedExtensionId(dir)`
— the path-derived one. Left alone, a pinned extension would have been given a
`chrome-extension://` URL that resolves to nothing, and “Open here” would open a
blank tab. It now prefers `extensionId` (the manifest-key id) and only falls
back to the path id. `extensionPageUrl()` also accepts the runtime id and the
store id.

---

## 4. Files touched

| File | Change |
|---|---|
| `src/core/ChromeExtensions.ts` | `webStoreIdFromInput`, `webStoreCrxUrl`, `downloadWebStoreCrx`, `installExtensionFromStore`, `crxPublicKey` (+ minimal protobuf reader), `extensionIdFromKey`, `writeManifestKey`, `resolveMessages`; `InstalledExtension` gains `extensionId` / `storeId` |
| `src/core/RealChrome.ts` | `loadedExtensions()` prefers the pinned id and exposes `runtimeId`; `extensionPageUrl()` matches runtime/store ids too |
| `src/Routes/browser.routes.ts` | `POST /browser/extensions/store` |
| `public/js/real-chrome.js` | URL field + Install button (Enter submits), extension id shown in the list, remote desktop demoted to optional |
| `public/js/i18n.js` | `rc.storeHint`, `rc.storePlaceholder`, `rc.installStore`, `rc.installing`, `rc.storeEmpty`, `rc.extIdHint`, `rc.desktopOptional` in **fa + en**; `rc.noExtensions` / `rc.desktopHint` reworded |
| `public/css/styles.css` | `.rc-store`, `.rc-input`, `.rc-ext-id` (monospace, `user-select: all`, LTR under RTL) |
| `tests/unit/webstore-install.test.ts` | **New** — 28 offline tests |

---

## 5. API

```bash
curl -X POST http://localhost:3000/browser/extensions/store \
  -H 'Content-Type: application/json' -H "x-api-key: $API_TOKEN" \
  -d '{"url":"https://chromewebstore.google.com/detail/j2team-cookies/okpidcojinmlaakglciglbpcpajaibco"}'
```

```jsonc
{
  "success": true,
  "extension": {
    "id": "okpidcojinmlaakglciglbpcpajaibco",
    "name": "J2TEAM Cookies",
    "version": "1.0.5",
    "manifestVersion": 3,
    "popup": "popup.html",
    "extensionId": "okpidcojinmlaakglciglbpcpajaibco",
    "storeId": "okpidcojinmlaakglciglbpcpajaibco"
  },
  "restartRequired": false,
  "message": "Installed J2TEAM Cookies v1.0.5. It will load the next time the browser starts."
}
```

Chrome reads `--load-extension` **once, at launch**, so a fresh install needs
`POST /browser/restart` when the browser is already running. The response says
so explicitly, and `restartRequired` drives the banner in the panel.

Failure messages are written to be actionable rather than technically precise:

| Situation | Message |
|---|---|
| Not a store link | *That does not look like a Chrome Web Store link.* + hint |
| Unknown / paid / region-locked id | *The Chrome Web Store has no downloadable item with id … paid or region-locked items cannot be fetched this way.* |
| Store unreachable / slow | *Could not reach the Chrome Web Store: …* / *Timed out …* |

---

## 6. Server requirements

* `unzip` — already required by the upload path.
* A display for headed Chrome: `REAL_CHROME_DISPLAY` (default `:99`) with Xvfb,
  **or** `REAL_CHROME_HEADLESS=true`. `xvfb` alone is enough — **x11vnc, noVNC
  and websockify are no longer needed** for extensions.
* `REAL_CHROME_ENABLED=true`.

---

## 7. Verification

Offline unit tests (28) build CRX3 fixtures in-process, so the suite never
depends on Google being reachable. Live checks performed:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `node --check` on touched client files | ✅ clean |
| `npx vitest run` | ✅ 44 files / 977 tests |
| Install via live HTTP API, both URL forms | ✅ `J2TEAM Cookies v1.0.5` |
| Re-install same extension | ✅ replaces, does not duplicate |
| `POST /browser/start` → extension loaded | ✅ `runtimeId` = store id |
| Popup renders in a page + `chrome.cookies` available | ✅ |
| Panel screenshots, en + fa (RTL) | ✅ no console errors |
| Error paths (bad URL, empty, unknown id) | ✅ actionable messages |

---

## 8. Not in scope / next

* **Auto-restart after install.** Deliberately not done: restarting Chrome drops
  every open picker session. The panel asks instead.
* **Update checking.** Re-pasting the link re-installs the current version;
  there is no "check for updates" poll.
* Paid, private and region-locked items cannot be fetched — Google requires a
  signed-in purchase token for those. The error says so.
