/**
 * node-toolbox.test.ts — regression guard for the two editor gaps closed in
 * this session:
 *
 *   H. the floating **Add Node** palette
 *      (docs/uiux/shell-add-node-palette.md § 2 "Right overlay")
 *   J. the full nine-row **node context menu**
 *      (same file, § 2 "Floating context menu")
 *   I. the **group-selection** boundary + action toolbar
 *      (same file, § 2 "Bottom group toolbar" + "The selected cluster is
 *      surrounded by a blue dashed group boundary")
 *
 * `flow-editor.js` is a DOM-bound IIFE and cannot be instantiated in a
 * `{ window: {} }` sandbox (see the note at the top of canvas-chrome.test.ts),
 * so the verifiable-without-a-DOM half is asserted here:
 *
 *   1. STRUCTURE — every row the spec lists is rendered, every entry point is
 *      wired, every advertised i18n key exists in BOTH dictionaries, and every
 *      icon name resolves in the registry (a typo silently renders the `dot`
 *      fallback, which is invisible in review);
 *   2. CONTRACTS — the second palette must REUSE the catalog renderer instead of
 *      owning a copy, the node colour can only ever be one of the design tokens,
 *      a clone must carry the annotations, and the inert row must LOOK inert.
 *
 * Behaviour that needs real geometry (panel placement, drag-to-empty-canvas
 * insertion, keyboard traversal) is verified in a browser against the static
 * preview server; the outcome is recorded in the session handoff.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(__dirname, '..', '..');
const FE = readFileSync(join(ROOT, 'public', 'js', 'flow-editor.js'), 'utf8');
const GSJS = readFileSync(join(ROOT, 'public', 'js', 'graph-serialize.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
const VIEWS = readFileSync(join(ROOT, 'public', 'js', 'views.js'), 'utf8');
const I18N_SRC = readFileSync(join(ROOT, 'public', 'js', 'i18n.js'), 'utf8');

/** Load the icon registry in a DOM-free sandbox (icons.js guards on `document`). */
function loadIcons(): { has: (n: string) => boolean } {
  const sandbox: any = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'public', 'js', 'icons.js'), 'utf8'), sandbox);
  return sandbox.window.Icons;
}

/** Both dictionaries, so a key added to `en` only cannot slip through. */
function dictionaries(): { fa: string; en: string } {
  const enAt = I18N_SRC.indexOf('    en: {');
  expect(enAt).toBeGreaterThan(0);
  return { fa: I18N_SRC.slice(0, enAt), en: I18N_SRC.slice(enAt) };
}

const ICONS = loadIcons();
const DICT = dictionaries();

function hasKeyInBothDicts(key: string): boolean {
  const needle = `'${key}':`;
  return DICT.fa.includes(needle) && DICT.en.includes(needle);
}

describe('item H — floating Add Node palette', () => {
  it('renders the panel the spec describes (title, search, categories, list)', () => {
    expect(FE).toContain("panel.className = 'fe-addnode'");
    expect(FE).toContain("panel.setAttribute('role', 'dialog')");
    expect(FE).toContain('an-search');
    expect(FE).toContain('an-cats');
    expect(FE).toContain('an-list');
    // The card is titled and closable, as pictured.
    expect(FE).toContain('an-title');
    expect(FE).toContain('an-close');
  });

  it('REUSES paletteItem() instead of shipping a second catalog renderer', () => {
    // The whole point of `opts.onPick`: one row renderer, two surfaces.
    expect(FE).toContain('function paletteItem(a, opts)');
    expect(FE).toContain('paletteItem(a, { onPick: addPick })');
    // ...and one grouping table, whose counts come from the real members.
    const addCats = FE.slice(FE.indexOf('function addCategories()'),
      FE.indexOf('function addMatches()'));
    expect(addCats).toContain('PALETTE_GROUPS.forEach');
    expect(addCats).toContain('members.length');
    expect(addCats).not.toMatch(/count:\s*\d+/);   // never a hardcoded count
  });

  it('search spans the whole catalog, not just the selected category', () => {
    const matches = FE.slice(FE.indexOf('function addMatches()'),
      FE.indexOf('function addPick('));
    // The category filter is only consulted when there is NO query.
    expect(matches).toContain('if (q)');
    expect(matches).toContain('NODE_DISPLAY_NAMES');   // human names are searchable too
    expect(matches.indexOf('if (q)')).toBeLessThan(matches.indexOf('addState.cat === ADD_ALL'));
  });

  it('wires all five entry points', () => {
    // 1. the empty-state CTA
    const empty = FE.slice(FE.indexOf('function renderEmptyState()'),
      FE.indexOf('function appendValidation('));
    expect(empty).toContain('openAddPaletteForSelection');
    // 2. the canvas toolbar pill
    expect(FE).toContain("data-view=\"addnode\"");
    expect(FE).toContain("if (v === 'addnode')");
    // 3. the Tab shortcut
    expect(FE).toMatch(/ev\.key === 'Tab'[\s\S]{0,200}openAddPaletteForSelection/);
    // 4. a connection dragged into empty canvas
    expect(FE).toMatch(/from: \{ nodeId: fromId, port: fromPort \}/);
    // 5. the circled `+` chip on a free output port (see the dedicated describe
    //    below for its rules) — the only entry point that pre-wires a SPECIFIC
    //    branch port without a drag.
    expect(FE).toContain("add.className = 'flow-port-add port-'");
    expect(FE).toMatch(/from: \{ nodeId: node\.id, port: p\.id \}/);
  });

  it('a connection dropped on CHROME cancels instead of inserting behind it', () => {
    // `lastIndexOf`: the mousemove branch reads `} else if (drag.type === …)`,
    // the mouseup branch (the one under test) is the last occurrence of each.
    const mouseup = FE.slice(FE.lastIndexOf("if (drag.type === 'connect')"),
      FE.lastIndexOf("if (drag.type === 'box')"));
    expect(mouseup).toContain('onCanvas');
    expect(mouseup).toContain('.fe-canvas-toolbar');
    expect(mouseup).toContain('.fe-minimap-wrap');
  });

  it('inserts at the requested point and wires the source port', () => {
    const pick = FE.slice(FE.indexOf('function addPick('), FE.indexOf('function renderAddList()'));
    expect(pick).toContain('addNode(actionId, snap(world.x), snap(world.y))');
    expect(pick).toContain('connect(from.nodeId, created, from.port');
    // The new node has to be visible, or the insert looks like it did nothing.
    expect(pick).toContain('centerOnNode(created)');
  });

  it('only offers the wiring when the source port is actually free', () => {
    const forSel = FE.slice(FE.indexOf('function openAddPaletteForSelection('));
    expect(forSel).toContain('state.edges.some');
    expect(forSel).toContain('free ?');
  });

  it('never stacks two inserted nodes on the same slot', () => {
    const slot = FE.slice(FE.indexOf('function slotAfter('),
      FE.indexOf('function openAddPaletteForSelection('));
    expect(slot).toContain('taken');
    expect(slot).toContain('snap(');
  });

  it('is dismissible by Esc, by its close button and by an outside click', () => {
    expect(FE).toMatch(/ev\.key === 'Escape'\) \{ closeNodeMenu\(\); closeInlinePrompt\(\); closeAddPalette\(\); \}/);
    expect(FE).toContain("panel.querySelector('.an-close')");
    expect(FE).toContain("document.querySelector('.fe-addnode') &&");
  });

  it('advertises its keys in BOTH dictionaries', () => {
    ['an.title', 'an.search', 'an.all', 'an.categories', 'an.fromNode',
      'an.hintEnter', 'an.hintKeys'].forEach((k) => {
      expect(hasKeyInBothDicts(k), k).toBe(true);
    });
  });

  it('has the CSS the JS toggles', () => {
    ['.fe-addnode', '.an-head', '.an-searchrow', '.an-body', '.an-cats', '.an-cat',
      '.an-list', '.an-foot', '.an-list .palette-item.is-active',
      '.flow-node.fe-node-pending'].forEach((sel) => {
      expect(CSS, sel).toContain(sel);
    });
  });
});

/**
 * The circled `+` on a free output port — the FIFTH Add Node entry point.
 *
 * It is in six of the eight locked images (right of a node, sitting on a short
 * connector stub), and it is the only entry point that pre-wires ONE SPECIFIC
 * branch port, so `else` / `catch` / `case:N` can be extended by a click instead
 * of a drag. Everything here is a rule that a future refactor could silently
 * break, so each one gets an assertion.
 */
describe('circled + on a free output port', () => {
  /** The chip is built inside the per-port loop of the card renderer. */
  const CHIP = FE.slice(FE.indexOf("// A FREE output port gets the circled `+` chip"),
    FE.indexOf('// connection drag — start on THIS output port'));

  it('is rendered ONLY on a port that has no edge yet', () => {
    // Same rule as openAddPaletteForSelection: offering "add" on a taken port
    // would silently replace that connection.
    expect(CHIP).toContain('var portTaken = state.edges.some(');
    expect(CHIP).toContain("(e.port || 'next') === p.id");
    expect(CHIP).toContain('if (!portTaken) {');
    // ...and the guard has to WRAP the chip, not merely precede it.
    expect(CHIP.indexOf('if (!portTaken) {'))
      .toBeLessThan(CHIP.indexOf("add.className = 'flow-port-add"));
  });

  it('opens the SHARED palette pre-wired to THAT port', () => {
    // No second palette, no second insert path: openAddPalette + slotAfter.
    expect(CHIP).toContain('openAddPalette({');
    expect(CHIP).toContain('world: slotAfter(node.id)');
    expect(CHIP).toContain('from: { nodeId: node.id, port: p.id }');
    // It opens next to the click, like the other entry points.
    expect(CHIP).toContain('at: { x: ev.clientX, y: ev.clientY }');
  });

  it('does not hijack the card: no node drag, no canvas click-through', () => {
    // The card's own mousedown starts a node drag — the chip must swallow it,
    // or every click on the chip would nudge the node.
    expect(CHIP).toMatch(/add\.addEventListener\('mousedown', function \(ev\) \{ ev\.stopPropagation\(\); \}\)/);
    // The click must not bubble to the card (which would select/open the NDV).
    expect(CHIP).toMatch(/add\.addEventListener\('click', function \(ev\) \{\s*\n\s*ev\.stopPropagation\(\);/);
  });

  it('is a real button with an accessible name from BOTH dictionaries', () => {
    expect(CHIP).toContain("add.type = 'button'");
    expect(CHIP).toContain("add.title = t('fe.addFromPort')");
    expect(CHIP).toContain("add.setAttribute('aria-label', t('fe.addFromPort'))");
    expect(hasKeyInBothDicts('fe.addFromPort')).toBe(true);
    // The glyph is a registry icon, not a literal "+" character.
    expect(CHIP).toContain("IC('plus'");
    expect(ICONS.has('plus')).toBe(true);
  });

  it('is centred on ITS OWN port, using half the CSS size', () => {
    // A branching node has several ports: the chip must follow portY(p.id), not
    // the card top, or all of them would stack at the same height.
    expect(CHIP).toContain("add.style.top = (portY(node, p.id) - node.y - PORT_ADD_R) + 'px'");
    expect(FE).toContain('var PORT_ADD_R = 9;');
    // 9 is half of the 18px chip — the two must stay in sync.
    const chipCss = CSS.slice(CSS.indexOf('.flow-port-add {'), CSS.indexOf('.flow-port-add::before'));
    expect(chipCss).toContain('width: 18px');
    expect(chipCss).toContain('height: 18px');
  });

  it('has the CSS the JS assumes: chip, connector stub, and it sits OUTSIDE the card', () => {
    const chipCss = CSS.slice(CSS.indexOf('.flow-port-add {'), CSS.indexOf('.flow-port-add:hover'));
    expect(chipCss).toContain('position: absolute');
    // Logical property: the chip has to flip with the RTL/LTR canvas.
    expect(chipCss).toContain('inset-inline-end:');
    expect(chipCss).not.toContain('right:');
    expect(chipCss).toContain('border-radius: 50%');
    // The stub that visually connects the chip to the port dot.
    expect(CSS).toContain('.flow-port-add::before');
    expect(CSS).toMatch(/\.flow-port-add::before \{[\s\S]{0,240}inset-inline-end: 100%/);
  });

  it('carries the SAME colour per port as the port dot itself', () => {
    // A green `+` on a red `else` port would read as the wrong branch.
    const pairs: Array<[string, string]> = [
      ['.flow-port-add.port-then', 'var(--success)'],
      ['.flow-port-add.port-else', 'var(--danger)'],
      ['.flow-port-add.port-catch', 'var(--danger)'],
      ['.flow-port-add.port-done', '#f5a623'],
      ['.flow-port-add.port-finally', '#f5a623'],
      ['.flow-port-add[class*="port-case-"]', '#06b6d4'],
    ];
    pairs.forEach(([sel, colour]) => {
      expect(CSS, sel).toContain(sel);
      // the colour is declared somewhere in the rule this selector participates in
      const at = CSS.indexOf(sel);
      expect(CSS.slice(at, at + 400), `${sel} -> ${colour}`).toContain(colour);
    });
    // `case:0` becomes `port-case-0`: the class sanitiser must strip the colon,
    // or the `[class*="port-case-"]` rule never matches.
    expect(FE).toContain("p.id.replace(/[^a-z0-9]+/gi, '-')");
  });

  it('disappears on a LOCKED canvas (a read-only graph must not offer inserts)', () => {
    expect(CSS).toContain('.fe-canvas.fe-locked .flow-port-add { display: none; }');
  });

  it('uses only tokens this stylesheet actually defines', () => {
    const chipCss = CSS.slice(CSS.indexOf('.flow-port-add {'),
      CSS.indexOf('.fe-canvas.fe-locked .flow-port-add'));
    ['--text-mute', '--accent', '--surface-2', '--text-disabled'].forEach((bad) => {
      expect(chipCss, bad).not.toContain(bad);
    });
  });
});

/**
 * Minimap viewport indicator. The frame is `union(nodes, viewport)`, so with a
 * couple of nodes the viewport rect is almost the whole widget; as a FILLED
 * `--primary-soft` block it covered the node dots and read as one orange smear.
 */
describe('minimap viewport reads as a frame, not a filled block', () => {
  const MM = CSS.slice(CSS.indexOf('.mm-viewport {'), CSS.indexOf('.fe-hint {'));

  it('is an outline with a see-through interior', () => {
    expect(MM).toContain('background: transparent');
    expect(MM).not.toContain('var(--primary-soft)');
    expect(MM).toContain('border: 1.5px solid var(--primary)');
  });

  it('dims the OUTSIDE with a scrim instead of tinting the inside', () => {
    expect(MM).toMatch(/box-shadow: 0 0 0 9999px rgba\(/);
    // The 9999px spread only works because the minimap clips it.
    const mapCss = CSS.slice(CSS.indexOf('.fe-minimap {'), CSS.indexOf('.mm-node {'));
    expect(mapCss).toContain('overflow: hidden');
  });

  it('never eats a click meant for the map itself', () => {
    expect(MM).toContain('pointer-events: none');
  });
});

describe('item J — full node context menu', () => {
  const menu = FE.slice(FE.indexOf('function openNodeMenu('), FE.indexOf('function renderNodes()'));

  it('renders all nine rows from the spec', () => {
    // Toggling rows read `t(cond ? 'fe.enableNode' : 'fe.disableNode')`, so the
    // guard is on the translated key, not on a fixed `t('…')` spelling.
    ['fe.cloneNode', 'fe.renameNode', 'fe.disableNode', 'fe.changeColor',
      'fe.addComment', 'fe.favNode', 'fe.convertSubflow', 'fe.advanced',
      'fe.deleteNode'].forEach((k) => {
      expect(FE, k).toContain(`'${k}'`);
    });
  });

  it('every menu label exists in BOTH dictionaries', () => {
    ['fe.close', 'fe.nodeMenu', 'fe.cloneNode', 'fe.renameNode', 'fe.disableNode',
      'fe.enableNode', 'fe.nodeDisabled', 'fe.offBadge', 'fe.changeColor',
      'fe.resetColor', 'fe.addComment', 'fe.editComment', 'fe.favNode',
      'fe.unfavNode', 'fe.favAdded', 'fe.favRemoved', 'fe.convertSubflow',
      'fe.convertSubflowSoon', 'fe.advanced', 'fe.copyNodeJson', 'fe.copiedJson',
      'fe.copyFailed', 'fe.runNode', 'fe.runNodeHint', 'fe.runNodeQueued',
      'fe.runNodeDisabled', 'fe.runNodeBranch', 'fe.promptOk',
      'fe.promptCancel', 'fe.promptHint'].forEach((k) => {
      expect(hasKeyInBothDicts(k), k).toBe(true);
    });
    // ...and so does the new validation warning.
    expect(hasKeyInBothDicts('val.disabledNode')).toBe(true);
  });

  it('every icon it names resolves in the registry', () => {
    ['copy', 'pencil', 'eye', 'eye-off', 'palette', 'message-square', 'star',
      'sitemap', 'sliders', 'pin', 'braces', 'play', 'trash', 'rotate-ccw',
      'chevron-right', 'plus', 'search', 'x', 'corner-down-left', 'keyboard']
      .forEach((n) => { expect(ICONS.has(n), n).toBe(true); });
  });

  it('the one unbacked row renders DISABLED with an explanation', () => {
    // `Convert Subflow` is now the ONLY unconditionally-disabled row: it needs a
    // container concept in the graph model that does not exist yet.
    expect(menu).toMatch(/label: t\('fe\.convertSubflow'\),\s*\n\s*disabled: true, hint: t\('fe\.convertSubflowSoon'\)/);
    // `Run node` (item N) is backed by POST /run-node, so it is disabled only
    // CONDITIONALLY — and every branch still carries a tooltip, so a dead row
    // always says why it is dead.
    expect(menu).toMatch(/label: t\('fe\.runNode'\),\s*\n\s*disabled: !!why, hint: why \? t\(why\) : t\('fe\.runNodeHint'\)/);
    expect(menu).toContain('runNodeBlockedReason(nodeId)');
    expect(menu).toContain('fn: function () { runNode(nodeId); }');
    // `fe.runNodeSoon` was the placeholder excuse; it must be gone from BOTH
    // dictionaries so nothing can quietly fall back to it.
    expect(I18N_SRC).not.toContain('fe.runNodeSoon');
    const item = FE.slice(FE.indexOf('function ctxItem('), FE.indexOf('function ctxColorRow('));
    expect(item).toContain("b.setAttribute('aria-disabled', 'true')");
    expect(item).toContain('b.disabled = true');
    // A disabled row must not be wired to anything.
    expect(item).toContain('if (!it.disabled && !it.submenu)');
  });

  it('the colour row can only ever store a design token', () => {
    expect(FE).toMatch(/var NODE_COLORS = \[[^\]]*'#FF8A1F'[^\]]*\]/);
    expect(FE).toContain('function isNodeColor(v)');
    // Both the writer and the renderer go through the whitelist.
    const set = FE.slice(FE.indexOf('function setNodeColor('), FE.indexOf('function setNodeDisabled('));
    expect(set).toContain('isNodeColor(color)');
    expect(FE).toContain("node.color && isNodeColor(node.color) ? node.color : cat.color");
  });

  it('a submenu is a sibling menu, so the close path stays single', () => {
    expect(FE).toContain("sub.className = 'fe-ctxmenu is-sub'");
    // closeNodeMenu() drains EVERY open menu, parent and submenu alike.
    const close = FE.slice(FE.indexOf('function closeNodeMenu()'), FE.indexOf('function ctxItem('));
    expect(close).toContain('while (ex)');
    // The outside-click guard has to test "inside ANY menu", not one element.
    expect(FE).toContain("ev.target.closest('.fe-ctxmenu')");
  });

  it('is operable by keyboard (it is reachable from the kebab button)', () => {
    expect(menu).toContain("menu.setAttribute('role', 'menu')");
    expect(menu).toContain("ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp'");
    expect(menu).toContain('rows[0].focus()');
  });

  it('Rename / Add Comment use an in-product popover, not window.prompt', () => {
    expect(FE).not.toMatch(/\bwindow\.prompt\(/);
    expect(FE).toContain('function openInlinePrompt(');
    const p = FE.slice(FE.indexOf('function openInlinePrompt('), FE.indexOf('// ---- Copy / paste'));
    // Enter commits (Ctrl/Cmd+Enter in a textarea), Esc cancels.
    expect(p).toContain("if (ev.key === 'Escape')");
    expect(p).toContain('o.multiline && !(ev.ctrlKey || ev.metaKey)');
    expect(p).toContain('input.focus()');
    ['.fe-prompt', '.fe-prompt-input', '.fe-prompt-ok', '.fe-prompt-cancel']
      .forEach((sel) => { expect(CSS, sel).toContain(sel); });
  });

  it('Copy node JSON serialises through the ONE serializer', () => {
    // The graph->step conversion lives in `nodeStepJson`, which the per-node and
    // the group copy both call: one place, so the two can never drift.
    const step = FE.slice(FE.indexOf('function nodeStepJson('),
      FE.indexOf('function writeClipboard('));
    expect(step).toContain('gs.graphToSteps(solo)');
    expect(step).toContain('delete solo.nodes[id].disabled');
    const c = FE.slice(FE.indexOf('function writeClipboard('),
      FE.indexOf('// ---- Inline prompt'));
    // Non-secure contexts have no navigator.clipboard, so there is a fallback.
    expect(c).toContain('document.execCommand');
    expect(c).toContain("t(ok ? 'fe.copiedJson' : 'fe.copyFailed')");
  });

  it('Favorites reuses the palette store and repaints both surfaces', () => {
    expect(menu).toContain('paletteFavs[node.action]');
    expect(menu).toContain('savePaletteFavs()');
    const star = FE.slice(FE.indexOf("var star = item.querySelector('.pi-star')"),
      FE.indexOf("item.addEventListener('dragstart'"));
    expect(star).toContain('renderPaletteList()');
    expect(star).toContain('renderAddList()');
  });
});

describe('node annotations — contracts', () => {
  it('the annotations live on the node, so undo/save/clipboard cover them', () => {
    // A clone that dropped them would silently produce a DIFFERENT node.
    const copy = FE.slice(FE.indexOf('function copySelection()'), FE.indexOf('function pasteClipboard()'));
    ['label', 'note', 'color', 'disabled', 'errorPolicy'].forEach((k) => {
      expect(copy, k).toContain(`n.${k}`);
    });
    const paste = FE.slice(FE.indexOf('function pasteClipboard()'), FE.indexOf('function addNode('));
    expect(paste).toContain('isNodeColor(c.color)');
  });

  it('every mutation is one undo step', () => {
    ['function renameNode(', 'function setNodeComment(', 'function setNodeColor(',
      'function setNodeDisabled(', 'function setSelectionDisabled('].forEach((fn) => {
      const body = FE.slice(FE.indexOf(fn), FE.indexOf(fn) + 900);
      expect(body, fn).toContain('pushHistory()');
      expect(body, fn).toContain('renderAll()');
    });
  });

  it('a rename shows up on the card AND in the OUTLINE', () => {
    const title = FE.slice(FE.indexOf('function nodeTitle(node)'), FE.indexOf('function nodeCardSummary('));
    expect(title).toContain('if (node.label) return String(node.label)');
    // The outline asks the editor for the same label, so there is one source.
    expect(FE).toContain('nodeLabel: function (nodeId)');
  });

  it('disabled + comment are visible on the canvas, not just in a menu', () => {
    expect(FE).toContain("(node.disabled === true ? ' is-off' : '')");
    expect(FE).toContain("off.className = 'fn-off'");
    expect(FE).toContain("note.className = 'fn-note'");
    ['.flow-node.is-off', '.fn-off', '.fn-note'].forEach((sel) => {
      expect(CSS, sel).toContain(sel);
    });
  });

  it('the OUTLINE mirrors the disabled state', () => {
    expect(GSJS).toContain('disabled: node.disabled === true');
    expect(VIEWS).toContain("(r.disabled ? ' is-off' : '')");
    expect(CSS).toContain('.fe-ol-row.is-off');
  });

  it('does not leak view state into the serialized graph', () => {
    // `addState` is the palette's transient view state and must stay module-level.
    expect(FE).toMatch(/var addState = null;/);
    const ser = FE.slice(FE.indexOf('function serialize()'), FE.indexOf('function saveLocal()'));
    ['addState', 'paletteFavs', 'paletteQuery'].forEach((v) => {
      expect(ser, v).not.toContain(v);
    });
  });
});

describe('item I — group selection boundary + toolbar', () => {
  const render = FE.slice(FE.indexOf('function renderSelectionTools()'),
    FE.indexOf('// ---- Canvas overlay:'));

  it('renders the seven spec buttons, in the spec order', () => {
    // shell-add-node-palette.md § 2 "Bottom group toolbar".
    const order = ['sel.disable', 'sel.delete', 'sel.clone', 'sel.group',
      'fe.convertSubflow', 'fe.addComment', 'sel.more'];
    let at = -1;
    order.forEach((k) => {
      const i = render.indexOf(`'${k}'`);
      expect(i, k).toBeGreaterThan(at);
      at = i;
    });
  });

  it('every label exists in BOTH dictionaries', () => {
    ['sel.toolbar', 'sel.selected', 'sel.disable', 'sel.enable', 'sel.delete',
      'sel.clone', 'sel.group', 'sel.groupSoon', 'sel.more', 'sel.copyJson',
      'sel.pinAll', 'sel.unpinAll', 'sel.alignRow'].forEach((k) => {
      expect(hasKeyInBothDicts(k), k).toBe(true);
    });
  });

  it('every icon it asks for resolves in the registry', () => {
    ['eye', 'eye-off', 'trash', 'copy', 'frame', 'sitemap', 'message-square',
      'more-vertical', 'braces', 'pin', 'layout', 'palette'].forEach((n) => {
      expect(ICONS.has(n), n).toBe(true);
    });
  });

  it('shows a REAL count, never a placeholder', () => {
    expect(render).toContain("count.className = 'fe-selcount'");
    expect(render).toContain('ids.length');
    // No hardcoded digit could ever reach the chip.
    expect(render).not.toMatch(/fe-selcount[\s\S]{0,200}<b>\s*\d/);
  });

  it('only appears for a MULTI selection', () => {
    expect(render).toContain('if (ids.length < 2) return;');
    // ...and never mid-drag, where the frame would lag a frame behind the cards.
    expect(render).toContain('if (drag) return;');
  });

  it('unbacked actions render disabled WITH a tooltip', () => {
    expect(render).toMatch(/label: t\('sel\.group'\), disabled: true, hint: t\('sel\.groupSoon'\)/);
    expect(render).toMatch(/t\('fe\.convertSubflow'\), disabled: true,\s*\n\s*hint: t\('fe\.convertSubflowSoon'\)/);
    const btn = FE.slice(FE.indexOf('function selBtn('), FE.indexOf('function openSelectionMore('));
    expect(btn).toContain('b.disabled = true');
    expect(btn).toContain("b.setAttribute('aria-disabled', 'true')");
    expect(btn).toContain('b.title = spec.hint || spec.label');
    // A dead button must also LOOK dead.
    ['.fe-selbtn.is-disabled', '.fe-selbtn:disabled'].forEach((sel) => {
      expect(CSS, sel).toContain(sel);
    });
  });

  it('mutates a whole selection in ONE undo step', () => {
    ['function setSelectionDisabled(', 'function setSelectionComment(',
      'function setSelectionColor(', 'function alignSelection('].forEach((fn) => {
      const from = FE.indexOf(fn);
      // Stop at the NEXT declaration, so a neighbour's pushHistory cannot leak
      // into the count and make this guard pass (or fail) for the wrong reason.
      const next = FE.indexOf('\n  function ', from + fn.length);
      const body = FE.slice(from, next === -1 ? undefined : next);
      // exactly one history entry per group mutation
      expect(body.split('pushHistory()').length - 1, fn).toBe(1);
    });
  });

  it('pins do NOT take a history step (they are view state)', () => {
    const body = FE.slice(FE.indexOf('function setSelectionPinned('),
      FE.indexOf('function nodeStepJson('));
    expect(body).not.toContain('pushHistory()');
  });

  it('group clone reuses the clipboard path instead of a second implementation', () => {
    expect(render).toContain('copySelection(); pasteClipboard();');
    expect(render).not.toContain('uid(');
  });

  it('the More menu reuses the context-menu renderers', () => {
    const more = FE.slice(FE.indexOf('function openSelectionMore('),
      FE.indexOf('function alignSelection('));
    expect(more).toContain('ctxColorRow(ids)');
    expect(more).toContain('ctxItem(it)');
    expect(more).toContain("menu.className = 'fe-ctxmenu'");
    // one colour renderer for both surfaces => one whitelist
    const row = FE.slice(FE.indexOf('function ctxColorRow('), FE.indexOf('function openNodeMenu('));
    expect(row).toContain('setSelectionColor(target, c)');
    expect(row).toContain('setNodeColor(nodeId, c)');
    expect(row).toContain('NODE_COLORS.forEach');
  });

  it('copies the selection through the ONE serializer', () => {
    const c = FE.slice(FE.indexOf('function copySelectionJson('),
      FE.indexOf('// ---- Inline prompt'));
    expect(c).toContain('nodeStepJson');
    expect(c).toContain('writeClipboard(');
    expect(c).not.toContain('graphToSteps');       // it goes through nodeStepJson
    // ...and the per-node twin uses the very same two helpers.
    const one = FE.slice(FE.indexOf('function copyNodeJson('),
      FE.indexOf('function copySelectionJson('));
    expect(one).toContain('nodeStepJson(id)');
    expect(one).toContain('writeClipboard(');
  });

  it('lives inside the zoomed world but cancels the zoom for its labels', () => {
    expect(FE).toContain("dom.world.style.setProperty('--fe-inv-scale'");
    expect(render).toContain('dom.world.appendChild(bar)');
    expect(render).toContain('dom.world.appendChild(frame)');
    const css = CSS.slice(CSS.indexOf('.fe-seltools {'));
    expect(css).toContain('scale(var(--fe-inv-scale, 1))');
  });

  it('is repainted by the same pass that paints selection on the cards', () => {
    const rn = FE.slice(FE.indexOf('function renderNodes()'), FE.indexOf('function renderEmptyState()'));
    expect(rn).toContain('renderSelectionTools()');
  });

  it('the boundary is the blue dashed frame the spec describes', () => {
    const css = CSS.slice(CSS.indexOf('.fe-selbox {'), CSS.indexOf('.fe-seltools {'));
    expect(css).toContain('dashed');
    expect(css).toContain('var(--info)');
    expect(css).toContain('pointer-events: none');
  });

  it('uses only design tokens this stylesheet actually defines', () => {
    // `--text-mute` / `--accent` do not exist here: a var() on them silently
    // falls back to a hardcoded hex and stops following the light theme.
    const own = CSS.slice(CSS.indexOf('/* ==========================================================================\n   ADD NODE PALETTE'));
    expect(own).not.toContain('var(--text-mute');
    expect(own).not.toContain('var(--accent');
    expect(own).not.toContain('var(--surface-2');
    expect(own).not.toContain('var(--text-disabled');
  });
});

// ---------------------------------------------------------------------------
// Item N — per-node Run (09-HANDOFF-item-N-per-node-run.md).
//
// The behaviour needs a live graph, so what is verified here is the *contract*:
// that the prefix is a real slice of toSteps(), that indexes are resolved through
// the STEP chain (the bug in § 3.1), that both entry points go through the same
// helper, and that nothing falls back to running the whole flow.
// ---------------------------------------------------------------------------
describe('item N — per-node run', () => {
  const API = readFileSync(join(ROOT, 'public', 'js', 'api.js'), 'utf8');
  const runNodeFn = FE.slice(FE.indexOf('function runNode(nodeId)'), FE.indexOf('function setNodeStatus('));

  it('sends the chain PREFIX — a literal slice of the serialization', () => {
    // Sending the lone step would leave its input empty and the NDV OUTPUT
    // column would show a lie, so the prefix is non-negotiable.
    expect(runNodeFn).toContain('toSteps().slice(0, idx + 1)');
    expect(runNodeFn).toContain('nodeIndex: idx');
    expect(runNodeFn).toContain('chainStepIndex(nodeId)');
  });

  it('talks to POST /run-node, not to POST /run', () => {
    expect(API).toContain("post('/run-node', payload)");
    expect(API).toContain('runNode: runNode,');
    expect(runNodeFn).toContain('API.runNode(uid,');
    expect(runNodeFn).not.toContain('API.runFlow');
  });

  it('never clicks the whole-flow Run button — the old fake success is gone', () => {
    // `.ndv-run-btn` used to do `closeNdv(); getElementById('fe-run').click()`,
    // i.e. it said "Run node" and ran the entire workflow.
    expect(FE).not.toContain("getElementById('fe-run')");
    const head = FE.slice(FE.indexOf("runBtn.className = 'ndv-run-btn'"), FE.indexOf("closeBtn.className = 'ndv-close'"));
    expect(head).toContain('runNodeBlockedReason(node.id)');
    expect(head).toContain('runNode(node.id)');
  });

  it('both entry points read the SAME blocked reason, so they cannot disagree', () => {
    expect(FE).toContain('function runNodeBlockedReason(nodeId)');
    const reason = FE.slice(FE.indexOf('function runNodeBlockedReason(nodeId)'), FE.indexOf('function runUserId()'));
    expect(reason).toContain("'fe.runNodeDisabled'");
    expect(reason).toContain("'fe.runNodeBranch'");
    // Two callers: the context-menu row and the NDV header button.
    expect(FE.split('runNodeBlockedReason(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('a blocked Run button LOOKS dead, not merely dimmed', () => {
    const css = CSS.slice(CSS.indexOf('.ndv-run-btn:hover'), CSS.indexOf('.ndv-close {'));
    expect(css).toContain('cursor: not-allowed');
    expect(css).toContain('var(--text-faint)');
    // ...and only tokens this stylesheet defines (the 08-HANDOFF trap).
    expect(css).not.toContain('var(--text-mute');
    expect(css).not.toContain('var(--surface-2');
    expect(css).not.toContain('var(--text-disabled');
    const head = FE.slice(FE.indexOf("runBtn.className = 'ndv-run-btn'"), FE.indexOf("closeBtn.className = 'ndv-close'"));
    expect(head).toContain("runBtn.setAttribute('aria-disabled', 'true')");
    // Every branch carries a tooltip — a dead control must say why.
    expect(head).toContain('runBtn.title =');
  });

  it('env_root is not treated as an automation user (views.js rule)', () => {
    const uid = FE.slice(FE.indexOf('function runUserId()'), FE.indexOf('function runNode(nodeId)'));
    expect(uid).toContain("'env_root'");
    expect(uid).toContain("return '0'");
    expect(VIEWS).toContain("uid === 'env_root'");
  });

  it('paints the node running immediately and rolls back to error on failure', () => {
    expect(runNodeFn).toContain("setNodeStatus(nodeId, 'running')");
    expect(runNodeFn).toContain("setNodeStatus(nodeId, 'error')");
    expect(runNodeFn).toContain("t('fe.runNodeQueued')");
  });

  it('streams the partial run into the ACTIVITY LOG like a normal run', () => {
    expect(runNodeFn).toContain('window.RunPanel');
    expect(runNodeFn).toContain('RP.startJob(');
  });

  it('exposes the helpers so views.js / a toolbar can reuse them', () => {
    expect(FE).toContain('chainStepIndex: chainStepIndex,');
    expect(FE).toContain('stepChainIds: stepChainIds,');
    expect(FE).toContain('runNode: runNode,');
  });
});

// ---------------------------------------------------------------------------
// 09-HANDOFF § 3.1 — the chain-index vs step-index divergence.
// ---------------------------------------------------------------------------
describe('step index resolution skips disabled nodes', () => {
  const RP = readFileSync(join(ROOT, 'public', 'js', 'run-panel.js'), 'utf8');

  it('run-panel still addresses nodes by STEP index', () => {
    // This is the caller whose indexes were being mis-resolved; if it ever stops
    // deriving nodeIndex0 from the step number, revisit stepChainIds().
    expect(RP).toMatch(/idx1\s*-\s*1/);
  });

  it('stepChainIds() is chainNodeIds() minus the disabled nodes', () => {
    const fn = FE.slice(FE.indexOf('function stepChainIds()'), FE.indexOf('function chainStepIndex(nodeId)'));
    expect(fn).toContain('chainNodeIds().filter');
    expect(fn).toContain('n.disabled !== true');
  });

  it('chainStepIndex() is its exact inverse', () => {
    const fn = FE.slice(FE.indexOf('function chainStepIndex(nodeId)'), FE.indexOf('function runNodeBlockedReason('));
    expect(fn).toContain('stepChainIds().indexOf(nodeId)');
  });

  it('EVERY index -> id resolver goes through stepChainIds()', () => {
    // The four public byIndex helpers plus setNodeStatus(number). Resolving any
    // of them through chainNodeIds() paints the wrong card once a node is
    // disabled, because graphToSteps() emits no step for it.
    ['setNodeResultsByIndex', 'selectByChainIndex', 'pinByIndex', 'isPinnedByIndex'].forEach((name) => {
      const i = FE.indexOf(name + ': function');
      expect(i, name).toBeGreaterThan(-1);
      const body = FE.slice(i, i + 400);
      expect(body, name).toContain('stepChainIds()');
      expect(body, name).not.toContain('chainNodeIds()');
    });
    const sns = FE.slice(FE.indexOf('function setNodeStatus(ref, status)'), FE.indexOf('function clearStatuses()'));
    expect(sns).toContain('stepChainIds()');
    expect(sns).not.toContain('chainNodeIds()');
  });

  it('the serializer that defines "a step" still skips disabled nodes', () => {
    // stepChainIds() is only correct while this stays true.
    expect(GSJS).toContain('disabled');
  });
});
