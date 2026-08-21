# Render vs. the two Reference images — Layout vs. State

Written because the request was explicit about wanting the *diagnosis*, not just
the patch:

> «قبل از تغییر UI، Render فعلی را با این دو Reference مقایسه کن و مشخص کن دقیقاً
> کدام تفاوت‌ها ناشی از Layout هستند و کدام‌ها ناشی از اشتباه State/Connection
> Logic.»

The distinction matters because the two classes have opposite risk profiles. A
**Layout** difference is cosmetic: the panel says something true, in the wrong
shape. A **State/Connection-Logic** difference means the panel says something
**false** — and every one found here was false in the direction that *hides* a
misconfiguration, which is the worst possible direction.

The governing precedence rule throughout:

> «منطق فنی و State را از اسپک قبلی بگیر، نه از متن‌های داخل Mockup. اگر یک متن
> داخل Mockup با منطق نهایی تناقض دارد، منطق نهایی اولویت دارد.»

So: Layout, card order, and *which sections appear* come from the references.
Technical logic and State come from the spec. Where a mockup **text** contradicts
the final logic, the logic wins.

---

## A. Differences caused by STATE / CONNECTION LOGIC

These were bugs. Each was proven with a failing test before being fixed.

### A1. REMOTE showed the server's own loopback address as the "Remote Backend"

The single most serious finding.

`paintConnection()` printed `res.baseUrl`, which always originates from the
**server-local** `inspectorContext()` (storage → seeded bootstrap →
`loopbackBase(port)`). Under REMOTE this rendered `http://127.0.0.1:3000` in a row
headed **BACKEND**, on a card headed **CONNECTION STATUS**, directly above an
empty Base URL box.

This is exactly what the request forbade:

> «هیچ 127.0.0.1:3000 یا Backend Local نباید به‌عنوان Remote Backend نمایش داده
> شود.»

Three independent sub-defects, each sufficient on its own:

1. `paintConnection()` was environment-blind.
2. It ran **before** `paintEnvironment()` settled `envState.current`, so it always
   read the *previous* environment.
3. A typed Base URL had no visible consequence anywhere on the panel.

Fixed by scoping the function to the chosen environment, re-ordering the paints,
and adding an `input` listener on `#authBase`. A deliberate **counterweight** test
asserts LOCAL *still* shows `127.0.0.1:3000`, so the fix cannot degenerate into
"never show loopback anywhere".

### A2. A "Connected" claim that outlived its evidence

Under REMOTE with no Base URL yet, the status line still read `Connected`.
Now three honest states: `Waiting for a base URL` → `Not connected yet` →
`Connected`, with FIELD ACCESS showing an em-dash rather than a false `Allowed`.

### A3. `[hidden]` did not hide — RELEASE THIS FIELD offered on an unbound field

The cold LOCAL state painted **RELEASE THIS FIELD** beneath a column of
em-dashes: an offer to release a field that was never bound.

Classified as State-logic rather than Layout because the *rendered affordance
contradicted the state*, even though the mechanism was CSS. `popup.js` set the
attribute correctly and `el.hidden === true`; the UA default
`[hidden] { display: none }` is a bare attribute selector, so `.btn`'s
`display: inline-flex` outranked it. Chromium painted the "hidden" button at
141×30px.

Notably **every DOM assertion agreed the button was hidden** — four of them — and
they were all correct. Only a screenshot of the built artifact could expose it.

---

## B. Differences caused by LAYOUT

True information, wrong shape.

### B1. The flow connector was clipped to an orange sliver

The `↓` between cards is a `::before` on the *following* card, pulled up by
`margin: -8px` so it lands in the 12px gutter — i.e. **outside its own card's
box**. `.card { overflow: hidden }` therefore cut it off.

The clipping was not pointless (it kept children inside the rounded corners), so
it moved to `.card > *` rather than being deleted, and a second test pins that
content clipping still exists somewhere.

### B2. A URL broken mid-token

`https://ops.example.com` wrapped with its final `m` alone on the next line, under
a BACKEND label — an address that *reads as corrupted* in the one row whose whole
job is to be trusted. `overflow-wrap: anywhere` → `break-word`.

### B3. The address column was too narrow — the actual cause of B2

`.statebox` split `1fr / 1.15fr` between a one-word status (`Connected`) and a full
URL, leaving the address 164px inside a 460px popup. Now `1fr / 2.2fr`, asserted
as a **ratio** so it survives a resize. Chromium confirms the address back to a
single 16px line at 219px.

### B4. The footnote box rendered as a column of single words

`.note` is itself a grid (`16px minmax(0,1fr)`). A `::before` on a grid
**container** is a **grid item**, not an overlay — so the connector arrow claimed
the 16px icon column, pushing the icon into the text column and the sentence into
the 16px one. Both references confirm 3 arrows (REMOTE) / 2 (LOCAL) and **none
above the footnote**.

### B5. Two bullets instead of one

`.tfstate::before` draws a 7px CSS disc that the tone class recolours, and the JS
strings *also* began with a literal `●`/`○`. Additive → `● ● Connected`.

Fixed centrally in `stateLine()` rather than at the seven call sites. The CSS disc
is the survivor for a concrete reason: **a glyph baked into a string cannot be
recoloured by state**, so the tone classes would have no visible effect on it.

### B6. "Connection active" printed twice in the same card

Found by putting the finished REMOTE render beside reference image 1. The pill at
the card's top-right said **"Connection Active"**, and `#ctState` at the same
card's bottom-left said **"Connection active"** — one fact, one card, two lines
apart, differing only in capitalisation. Both references print it exactly once, in
the pill.

Classified as **layout/redundancy, not state**: both lines were reading the same
correct `live` boolean, so nothing was lying. What was wrong was spending the one
line that has to carry the *bad* news — `Bound, but that field is no longer open`
— on a paraphrase of the pill in the good case. The operator then has no way to
learn that this line is the one that changes.

Fixed by blanking `#ctState` while live (`.tfstate:empty` is `display:none`, so the
line is **absent** rather than greyed out) and leaving every other branch intact.
The narrowness matters: `'survives the address going stale'` in
`popup-inspector-pairing.test.ts` requires this element to still report
`/no longer open/i` while `#ctPairing` reports `/stays targeted/i`, and that split
is the entire reason both elements exist. A counterweight test pins that the line
still speaks when stale, so the fix cannot decay into having deleted a diagnostic.

---

## C. Mockup texts deliberately NOT copied

Where the references and the final logic disagree, the logic wins.

### C1. Both mockups label REMOTE "Server browser"

Not copied. LOCAL *is* the server's browser; REMOTE is the operator's own machine.
Copying this label would invert the core contract. Pinned by a test.

### C2. BINDING as `Active` / `—`

**I got this wrong first, and reverted it.** I transcribed the row literally —
image 1 reads `Active`, image 2 an em-dash — made the row a bare value, and moved
its guidance to the summary line. Five tests went red, and those five were right:

- BINDING is the **only** surface reporting the **durable pairing**, which stays
  true across NDV re-opens, while `Connected` tracks the **live address** and goes
  false on every re-open. `Active` is indistinguishable from "the address is up" —
  re-creating the exact conflation the separate line exists to prevent.
- An em-dash names **no next action**, and the action differs by environment:
  LOCAL binds the instant the crosshair is used; REMOTE waits on an approval.
- Moving the guidance onto `ctState` collapsed address and pairing into one line,
  so a stale node read as fully wired.

The row keeps its sentence. Its bullet also stays — `.ivalue` has **no**
`::before`, so unlike `.tfstate` that glyph is the row's only dot, not a
duplicate. That asymmetry is why `stateLine()` strips and `value()` does not.

### C3. Image 2's RELEASE button drawn enabled

The reference draws it enabled *alongside* all-dash rows and an ON "Connection
Active" toggle. That is not a coherent state — it is a static design showing every
affordance at once. The product hides the button until something is bound.

### C4. "Plyn"

A foreign product name in the mockup chrome. `grep -rc "Plyn"` → 0.

### C5. The connectors, where the two references contradict each other

Image 1 draws a vertical orange line ending in a filled triangular arrowhead
between cards. Image 2 draws **no connector at all** — the cards sit in plain empty
space. The render shows a plain `↓` glyph in both.

Not changed, and the reason is the precedence rule rather than taste. The two
references cannot both be satisfied by a fixed decoration, so the connector has to
be produced by a *rule*, and the rule that reproduces both is adjacency:

```css
.panel .card + .card:not([hidden])::before { content: '\2193'; … }
```

A `hidden` card stops being the adjacent sibling, so its arrow disappears with it —
which is how LOCAL loses both the REMOTE card and that card's connector from one
declaration, with no environment-specific styling anywhere. Chromium confirms the
count follows the state: **REMOTE 3** (`Connection status`, `Remote browser
connection`, `Connected to target`), **LOCAL 2**, and never one above the first
card or the footnote. Swapping the glyph for a drawn line-plus-arrowhead would be
cosmetic only and would risk the clipping defect of B1 again, since the connector
is painted outside its own card's box.

---

## D. What the two states must look like — confirmed

| | LOCAL | REMOTE |
|---|---|---|
| Remote Connection card | **absent** | present |
| Base URL | not requested | user-settable |
| Authorization Code | **does not exist at all** | present |
| Backend shown | own loopback, real | the typed remote URL, real |
| Connection Status | real local state | real remote state |

LOCAL is verified free of every authorization surface **in both directions** —
switching to REMOTE and back — because a one-way check would pass on a panel that
never re-hides what it revealed.

---

## E. Why the tests did not catch B and A3

Every defect in section B, plus A3, was invisible to a green suite, because in each
case **the markup was valid and the stylesheet parsed** — the damage lived only in
their *sum*, in a real layout engine.

jsdom does not implement `getComputedStyle(el, '::before')`: it logs
`Error: Not implemented` and returns nothing, so a pseudo-element assertion there
passes **vacuously**. Those facts are therefore asserted either in Chromium or
against the stylesheet text, and the comment-stripping helpers carry a sanity
check (`expect(live).toContain('.card {')`) so a test cannot pass by reading an
empty string — a mistake made earlier in this work and corrected.
