import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// ════════════════════════════════════════════════════════════════
// extension/lib/ab-inspect.js — the Element Inspector's extraction core.
//
// The requirement these tests defend is the one most easily broken by a
// well-meaning refactor: attribute extraction must be GENERIC. A future edit
// that "tidies up" collectAttributes into a whitelist would pass a casual
// review and silently make data-product unreachable, so the generic cases are
// asserted explicitly and by name.
//
// Run in a `vm` sandbox against a hand-rolled fake DOM, matching the existing
// extension-selector.test.ts approach (there is no jsdom in this repo).
// ════════════════════════════════════════════════════════════════

class FakeEl {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  attrs: Record<string, string>;
  childrenArr: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  innerText = '';
  value?: string;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
  }
  get id() { return this.attrs.id || ''; }
  getAttribute(k: string) { return this.attrs[k] != null ? this.attrs[k] : null; }
  get parentNode() { return this.parentElement; }
  get children() { return this.childrenArr; }
  get textContent(): string {
    if (this.innerText) return this.innerText;
    return this.childrenArr.map((c) => c.textContent).join('');
  }
  /** ab-inspect reads `el.attributes` as an indexed, .length-bearing list. */
  get attributes() {
    const keys = Object.keys(this.attrs);
    const list: Array<{ name: string; value: string }> & { length: number } =
      keys.map((k) => ({ name: k, value: this.attrs[k]! })) as never;
    return list;
  }
  append(child: FakeEl) { child.parentElement = this; this.childrenArr.push(child); return child; }
}

interface Described {
  tag: string; id: string; classes: string[]; css: string; xpath: string;
  text: string; value: string; name: string; role: string; type: string;
  attrs: Array<{ name: string; value: string }>;
  url: string; title: string;
}
interface Row { key: string; label: string; value: string; group: string; empty: boolean }

let ABInspect: {
  collectAttributes: (el: unknown) => Array<{ name: string; value: string }>;
  suggestedKeys: (el: unknown) => string[];
  describeElement: (el: unknown, sel?: unknown, meta?: unknown) => Described | null;
  attributeRows: (d: unknown) => Row[];
  defaultSelection: (d: unknown) => string[];
  shortLabel: (d: unknown) => string;
  roleOf: (el: unknown) => string;
  textOf: (el: unknown) => string;
  VALUE_CAP: number;
};

// A stand-in for window.ABSelector, so describeElement's injection seam is
// exercised the same way the content script uses it.
const fakeSelectors = {
  cssPath: (el: unknown) => {
    const e = el as FakeEl;
    return e.id ? `#${e.id}` : e.tagName.toLowerCase();
  },
  xPath: (el: unknown) => {
    const e = el as FakeEl;
    return e.id ? `//*[@id="${e.id}"]` : `/${e.tagName.toLowerCase()}[1]`;
  },
};

beforeAll(() => {
  const code = readFileSync(resolve(__dirname, '../../extension/lib/ab-inspect.js'), 'utf8');
  const sandbox: Record<string, unknown> = { window: {} as Record<string, unknown>, module: undefined };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  ABInspect = (sandbox.window as Record<string, unknown>).ABInspect as typeof ABInspect;
});

describe('ab-inspect: attribute extraction is generic (no hardcoded list)', () => {
  it('extracts arbitrary data-* attributes nobody predicted', () => {
    const el = new FakeEl('div', {
      'data-id': '42',
      'data-product': 'widget',
      'data-category': 'tools',
      // The point of the requirement: an attribute invented by one site.
      'data-flux-capacitor-v2': 'yes',
    });
    const attrs = ABInspect.collectAttributes(el);
    const byName: Record<string, string> = {};
    attrs.forEach((a) => { byName[a.name] = a.value; });

    expect(byName['data-id']).toBe('42');
    expect(byName['data-product']).toBe('widget');
    expect(byName['data-category']).toBe('tools');
    expect(byName['data-flux-capacitor-v2']).toBe('yes');
  });

  it('lower-cases and de-duplicates attribute names', () => {
    // HTML attribute names are case-insensitive; two rows for one attribute
    // would let a user tick contradictory things.
    const el = new FakeEl('div', { 'DATA-ID': 'a' });
    const attrs = ABInspect.collectAttributes(el);
    expect(attrs.map((a) => a.name)).toEqual(['data-id']);
  });

  it('returns [] rather than throwing for a non-element', () => {
    expect(ABInspect.collectAttributes(null)).toEqual([]);
    expect(ABInspect.collectAttributes({})).toEqual([]);
  });
});

describe('ab-inspect: the requirement groups are all reachable', () => {
  it('link and media attributes (a/img/audio/video)', () => {
    const a = new FakeEl('a', { href: '/buy', target: '_blank', title: 'Buy' });
    const rowsA = ABInspect.attributeRows(ABInspect.describeElement(a, fakeSelectors));
    const keysA = rowsA.map((r) => r.key);
    expect(keysA).toContain('href');
    expect(keysA).toContain('target');

    const v = new FakeEl('video', {
      src: 'clip.mp4', autoplay: '', controls: '', loop: '', width: '640', height: '480',
    });
    const keysV = ABInspect.attributeRows(ABInspect.describeElement(v, fakeSelectors)).map((r) => r.key);
    ['src', 'autoplay', 'controls', 'loop', 'width', 'height'].forEach((k) => {
      expect(keysV).toContain(k);
    });

    const img = new FakeEl('img', { src: 'a.png', alt: 'A', width: '10', height: '20' });
    const keysI = ABInspect.attributeRows(ABInspect.describeElement(img, fakeSelectors)).map((r) => r.key);
    ['src', 'alt', 'width', 'height'].forEach((k) => expect(keysI).toContain(k));
  });

  it('form and input attributes', () => {
    const input = new FakeEl('input', {
      type: 'text', name: 'q', placeholder: 'Search', required: '',
      disabled: '', readonly: '', maxlength: '10', min: '1', max: '5',
    });
    input.value = 'typed';
    const d = ABInspect.describeElement(input, fakeSelectors)!;
    const keys = ABInspect.attributeRows(d).map((r) => r.key);
    ['placeholder', 'required', 'disabled', 'readonly', 'maxlength', 'min', 'max'].forEach((k) => {
      expect(keys).toContain(k);
    });
    // type/name/value get their own dedicated rows.
    expect(keys).toContain('type');
    expect(keys).toContain('name');
    expect(keys).toContain('value');

    const form = new FakeEl('form', { action: '/submit', method: 'post' });
    const fk = ABInspect.attributeRows(ABInspect.describeElement(form, fakeSelectors)).map((r) => r.key);
    expect(fk).toContain('action');
    expect(fk).toContain('method');
  });

  it('table and list attributes (colspan/rowspan/reversed/start)', () => {
    const td = new FakeEl('td', { colspan: '2', rowspan: '3' });
    const tk = ABInspect.attributeRows(ABInspect.describeElement(td, fakeSelectors)).map((r) => r.key);
    expect(tk).toContain('colspan');
    expect(tk).toContain('rowspan');

    const ol = new FakeEl('ol', { reversed: '', start: '5' });
    const ok = ABInspect.attributeRows(ABInspect.describeElement(ol, fakeSelectors)).map((r) => r.key);
    expect(ok).toContain('reversed');
    expect(ok).toContain('start');
  });

  it('global attributes', () => {
    const el = new FakeEl('div', {
      id: 'x', class: 'a b', style: 'color:red', title: 't', dir: 'rtl',
      lang: 'fa', hidden: '', tabindex: '0', contenteditable: 'true',
    });
    const keys = ABInspect.attributeRows(ABInspect.describeElement(el, fakeSelectors)).map((r) => r.key);
    ['style', 'title', 'dir', 'lang', 'hidden', 'tabindex', 'contenteditable'].forEach((k) => {
      expect(keys).toContain(k);
    });
    // id and class are present as identity rows rather than duplicated.
    expect(keys).toContain('id');
    expect(keys).toContain('class');
    expect(keys.filter((k) => k === 'id')).toHaveLength(1);
    expect(keys.filter((k) => k === 'class')).toHaveLength(1);
  });
});

describe('ab-inspect: describeElement', () => {
  it('captures the full structured shape', () => {
    const el = new FakeEl('button', { id: 'buy', class: 'btn primary', type: 'submit', name: 'go' });
    el.innerText = '  Add   to\n cart ';
    const d = ABInspect.describeElement(el, fakeSelectors, { url: 'https://x.test/p', title: 'P' })!;

    expect(d.tag).toBe('button');
    expect(d.id).toBe('buy');
    expect(d.classes).toEqual(['btn', 'primary']);
    expect(d.css).toBe('#buy');
    expect(d.xpath).toBe('//*[@id="buy"]');
    // Whitespace collapsed: this is what the user SEES, not the raw markup.
    expect(d.text).toBe('Add to cart');
    expect(d.name).toBe('go');
    expect(d.type).toBe('submit');
    expect(d.url).toBe('https://x.test/p');
    expect(d.title).toBe('P');
  });

  it('reads the live value property, not the default attribute', () => {
    // The attribute is the default; the property is what the user typed. A
    // person inspecting a filled field means what is in it now.
    const el = new FakeEl('input', { value: 'default' });
    el.value = 'what the user typed';
    expect(ABInspect.describeElement(el, fakeSelectors)!.value).toBe('what the user typed');
  });

  it('survives selector helpers that throw', () => {
    const el = new FakeEl('div', { id: 'a' });
    const boom = { cssPath: () => { throw new Error('x'); }, xPath: () => { throw new Error('y'); } };
    const d = ABInspect.describeElement(el, boom)!;
    // A description with no CSS path is still worth showing.
    expect(d).toBeTruthy();
    expect(d.css).toBe('');
    expect(d.xpath).toBe('');
    expect(d.tag).toBe('div');
  });

  it('returns null for a missing element', () => {
    expect(ABInspect.describeElement(null, fakeSelectors)).toBeNull();
  });

  it('caps very long values', () => {
    const huge = 'x'.repeat(ABInspect.VALUE_CAP + 500);
    const el = new FakeEl('img', { src: huge });
    const d = ABInspect.describeElement(el, fakeSelectors)!;
    const src = d.attrs.find((a) => a.name === 'src')!;
    expect(src.value.length).toBe(ABInspect.VALUE_CAP);
  });
});

describe('ab-inspect: roles', () => {
  it('prefers an explicit role', () => {
    expect(ABInspect.roleOf(new FakeEl('div', { role: 'tab' }))).toBe('tab');
  });
  it('falls back to the implicit role of the tag', () => {
    expect(ABInspect.roleOf(new FakeEl('a'))).toBe('link');
    expect(ABInspect.roleOf(new FakeEl('button'))).toBe('button');
    expect(ABInspect.roleOf(new FakeEl('select'))).toBe('combobox');
  });
  it('refines input roles by type', () => {
    // An <input type=checkbox> is not a textbox.
    expect(ABInspect.roleOf(new FakeEl('input', { type: 'checkbox' }))).toBe('checkbox');
    expect(ABInspect.roleOf(new FakeEl('input', { type: 'radio' }))).toBe('radio');
    expect(ABInspect.roleOf(new FakeEl('input', { type: 'submit' }))).toBe('button');
    expect(ABInspect.roleOf(new FakeEl('input', { type: 'text' }))).toBe('textbox');
  });
});

// ════════════════════════════════════════════════════════════════
// §14 — MISSING ATTRIBUTES MUST NOT BE DISPLAYED
//
// «Missing attributes must simply not appear in the dynamically discovered
// list… The Attributes panel should look like a real browser DOM inspector, not
// a checklist of all possible HTML attributes.»
//
// This is not only cosmetic. A placeholder row offers the user a radio they can
// select, and the server refuses a send whose value is empty — so it is a button
// whose only outcome is an error.
//
// THE LINE IS *PRESENCE*, NOT TRUTHINESS, and these tests pin that distinction
// from both sides:
//
//   MISSING  — the element does not carry it. No row. (`<div>` has no href.)
//   PRESENT  — the element carries it, even as the empty string. Row kept,
//              because `<ol reversed>` and `<input required>` are exactly how
//              HTML spells a boolean attribute, and real DevTools shows them.
//
// tag / css / xpath are always emitted, and that is not a §14 exception: they
// are never missing. Every element has a tag name, and describeElement computes
// a path and an XPath for every element. They are also the only rows that tell a
// node how to FIND the element.
// ════════════════════════════════════════════════════════════════

describe('ab-inspect §14: a row appears only when the thing exists', () => {
  it('omits the derived id, class and text rows for an element that has none', () => {
    const el = new FakeEl('span');
    const keys = ABInspect.attributeRows(
      ABInspect.describeElement(el, fakeSelectors),
    ).map((r) => r.key);
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('class');
    expect(keys).not.toContain('text');
  });

  it('still always offers tag, css and xpath', () => {
    // Without these the panel would have nothing selectable to send.
    const el = new FakeEl('span');
    const keys = ABInspect.attributeRows(
      ABInspect.describeElement(el, fakeSelectors),
    ).map((r) => r.key);
    expect(keys).toContain('tag');
    expect(keys).toContain('css');
    expect(keys).toContain('xpath');
  });

  it('shows id, class and text as soon as they DO have a value', () => {
    const el = new FakeEl('span', { id: 'buy', class: 'btn primary' });
    el.innerText = 'Buy now';
    const rows = ABInspect.attributeRows(ABInspect.describeElement(el, fakeSelectors));
    const byKey: Record<string, Row> = {};
    rows.forEach((r) => { byKey[r.key] = r; });
    expect(byKey.id!.value).toBe('buy');
    expect(byKey.class!.value).toBe('btn primary');
    expect(byKey.text!.value).toBe('Buy now');
  });

  it('KEEPS a present-but-empty attribute, because that is a boolean attribute', () => {
    // The other side of the rule. `<ol reversed>` carries `reversed=""`; hiding
    // it would lose information the element genuinely has, and would contradict
    // the requirement that every discovered attribute be reachable.
    const ol = new FakeEl('ol', { reversed: '' });
    const rows = ABInspect.attributeRows(ABInspect.describeElement(ol, fakeSelectors));
    const reversed = rows.find((r) => r.key === 'reversed');
    expect(reversed).toBeTruthy();
    expect(reversed!.value).toBe('');
    // Flagged so a renderer can style it differently from a row carrying text.
    expect(reversed!.empty).toBe(true);
  });

  it('emits no row for an attribute the element does not carry', () => {
    // The general form, asserted over the whole list rather than a named few:
    // every non-identity row must correspond to a real attribute.
    const el = new FakeEl('div', { 'data-sku': 'A1' });
    const rows = ABInspect.attributeRows(ABInspect.describeElement(el, fakeSelectors));
    const carried = new Set(Object.keys(el.attrs));
    const derived = new Set(['tag', 'css', 'xpath', 'id', 'class', 'text', 'value', 'name', 'role', 'type']);
    const invented = rows.filter((r) => !derived.has(r.key) && !carried.has(r.key));
    expect(invented).toEqual([]);
  });

  it('keeps the panel free of the whole global-attribute checklist', () => {
    // GLOBAL_HINTS is an ORDERING hint, not a row source. A bare <div> must not
    // sprout `style —`, `title —`, `dir —`, `lang —` rows.
    const el = new FakeEl('div');
    const keys = ABInspect.attributeRows(
      ABInspect.describeElement(el, fakeSelectors),
    ).map((r) => r.key);
    ['style', 'title', 'dir', 'lang', 'hidden', 'placeholder', 'src', 'alt', 'method']
      .forEach((k) => expect(keys).not.toContain(k));
    // …and the panel is short, like a real DOM inspector.
    expect(keys).toEqual(['tag', 'css', 'xpath']);
  });

  it('preserves the familiar row order when values are present', () => {
    const el = new FakeEl('a', { id: 'buy', class: 'btn' });
    el.innerText = 'Buy';
    const keys = ABInspect.attributeRows(
      ABInspect.describeElement(el, fakeSelectors),
    ).map((r) => r.key);
    expect(keys.slice(0, 6)).toEqual(['tag', 'id', 'class', 'css', 'xpath', 'text']);
  });

  it('an explicitly empty id stays reachable as the attribute it really is', () => {
    // `<div id="">` HAS an id attribute whose value is empty. The derived `id`
    // row is dropped (it describes nothing useful), but the attribute itself is
    // still discovered — the skip-list is built from the rows actually emitted,
    // so the two rules cannot disagree and silently hide it.
    const el = new FakeEl('div', { id: '' });
    const rows = ABInspect.attributeRows(ABInspect.describeElement(el, fakeSelectors));
    expect(rows.filter((r) => r.key === 'id')).toHaveLength(1);
    expect(rows.find((r) => r.key === 'id')!.group).toBe('attribute');
  });
});

describe('ab-inspect: rows, defaults and labels', () => {
  it('marks data-* rows as their own group so the panel can highlight them', () => {
    const el = new FakeEl('div', { 'data-sku': 'A1', href: '#' });
    const rows = ABInspect.attributeRows(ABInspect.describeElement(el, fakeSelectors));
    expect(rows.find((r) => r.key === 'data-sku')!.group).toBe('data');
    expect(rows.find((r) => r.key === 'href')!.group).toBe('attribute');
  });

  it('defaults to css, plus the obvious payload for links and media', () => {
    // Pre-ticking everything would make the user UNtick nine things.
    expect(ABInspect.defaultSelection(
      ABInspect.describeElement(new FakeEl('div'), fakeSelectors),
    )).toEqual(['css']);

    expect(ABInspect.defaultSelection(
      ABInspect.describeElement(new FakeEl('a', { href: '/x' }), fakeSelectors),
    )).toEqual(['css', 'href']);

    expect(ABInspect.defaultSelection(
      ABInspect.describeElement(new FakeEl('img', { src: 'a.png' }), fakeSelectors),
    )).toEqual(['css', 'src']);
  });

  it('builds a short label', () => {
    expect(ABInspect.shortLabel(
      ABInspect.describeElement(new FakeEl('a', { id: 'buy' }), fakeSelectors),
    )).toBe('a#buy');
    expect(ABInspect.shortLabel(
      ABInspect.describeElement(new FakeEl('a', { class: 'btn x' }), fakeSelectors),
    )).toBe('a.btn');
    expect(ABInspect.shortLabel(
      ABInspect.describeElement(new FakeEl('a'), fakeSelectors),
    )).toBe('a');
  });

  it('suggestedKeys puts tag-relevant attributes first but keeps everything', () => {
    const el = new FakeEl('a', { 'data-x': '1', href: '/y' });
    const keys = ABInspect.suggestedKeys(el);
    // href before data-x (ordering), and data-x still present (not filtered).
    expect(keys.indexOf('href')).toBeLessThan(keys.indexOf('data-x'));
    expect(keys).toContain('data-x');
  });
});
