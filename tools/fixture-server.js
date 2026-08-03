/**
 * tools/fixture-server.js — a tiny real HTTP origin for live probes.
 *
 * WHY THIS EXISTS (measured, 2026-08-03): probes originally drove the browser at
 * `data:text/html,...` URLs. Chrome REFUSES a top-level navigation to a data:
 * URL — the session lands on `chrome-error://chromewebdata/` and every
 * subsequent assertion measures the error page instead of the fixture. That one
 * mistake made ~20 live checks look like product bugs. A real origin on
 * 127.0.0.1 is the only honest way to test a browser.
 *
 * It also gives us things data: URLs can never provide: a 401 challenge for
 * basic auth, a Content-Disposition attachment for the download shelf, and a
 * favicon for the tab strip.
 */
'use strict';

const http = require('http');

/**
 * Every fixture page gets this. The probe cannot read the page directly — the
 * live `verify` command only COUNTS elements — so pages report their own state
 * back to this server and the probe reads it over HTTP. That keeps the probe
 * measuring the real browser's behaviour rather than trusting a mock.
 */
const BEACON = '<script>function R(k,v){'
  + 'try{fetch("/report?k="+encodeURIComponent(k)+"&v="+encodeURIComponent(String(v)),'
  + '{method:"POST",keepalive:true})}catch(e){}}</script>';

const PAGES = {
  '/one': '<h1 id=one>ONE</h1><p>page one</p>',
  '/two': '<h1 id=two>TWO</h1><p>page two</p>',
  '/three': '<h1 id=three>THREE</h1><p>page three</p>',

  // A paragraph with well-spaced words: dblclick → one word, triple → all of it.
  '/words': '<p id=p style="font-size:28px;padding:40px;line-height:1.8">'
    + 'alpha bravo charlie delta echo foxtrot golf hotel</p>',

  // Records every keydown it sees, with its modifier flags, so the probe can
  // prove the whole keyboard arrives — not a 9-item whitelist.
  '/keys': '<input id=i style="font-size:28px;width:90%"><pre id=log></pre>'
    + '<script>var s=[];var i=document.getElementById("i");'
    + 'i.addEventListener("keydown",function(e){'
    + 's.push((e.ctrlKey?"C":"")+(e.shiftKey?"S":"")+(e.altKey?"A":"")+(e.metaKey?"M":"")+e.key);'
    + 'document.getElementById("log").textContent=s.join("|");R("keys",s.join("|"))});'
    + 'i.focus();</script>',

  // Reports the live selection every time it changes, so the probe can prove
  // that dblclick selects a word, triple-click a paragraph, and a drag a range.
  //
  // It ALSO reports where its own glyphs are, under the key `geom`.
  // MEASURED 2026-08-03: for a long time this fixture cost us a false failure.
  // The probe hard-coded y=55 for the text, but this paragraph is padded 40px
  // inside a margined <p> inside a margined <body>, so the first line of glyphs
  // actually sits near y=95. A drag along y=55 travels across empty padding and
  // correctly selects nothing — and we spent a lot of effort looking for a bug
  // in `drag()` that was never there. A page that measures itself cannot lie
  // about its own layout, so the probe now asks instead of guessing.
  '/select': '<p id=p style="font-size:28px;padding:40px;line-height:1.9">'
    + 'alpha bravo charlie delta echo foxtrot golf hotel india juliet</p>'
    + '<script>document.addEventListener("selectionchange",function(){'
    + 'R("sel",String(document.getSelection()))});'
    + '(function(){var n=document.getElementById("p").firstChild;'
    + 'var r=document.createRange();r.setStart(n,0);r.setEnd(n,4);'
    + 'var h=r.getClientRects()[0];r.setStart(n,20);r.setEnd(n,24);'
    + 'var t=r.getClientRects()[0];'
    + 'R("geom",[Math.round(h.top+h.height/2),Math.round(h.left+2),'
    + 'Math.round(t.right-2)].join(","))})();</script>',

  '/link': '<a id=a href="/two" style="font-size:30px">a link</a>',
  '/img': '<img id=m src="/pixel.png" width=200 height=120 alt=pixel>',

  '/alert': 'before<script>alert("hello from the page")</script>after',
  '/confirm': '<div id=out>-</div><script>'
    + 'var a=confirm("really?");document.getElementById("out").textContent="got:"+a;'
    + 'R("confirm",a);</script>',
  '/prompt': '<div id=out>-</div><script>'
    + 'var a=prompt("your name?","");document.getElementById("out").textContent="got:"+a;'
    + 'R("prompt",a);</script>',

  // Guards its own unload. Chrome only honours this after a user gesture, so the
  // probe clicks the button first.
  '/leave': '<button id=b style="font-size:30px">click me first</button>'
    + '<script>document.getElementById("b").onclick=function(){window.__t=1};'
    + 'addEventListener("beforeunload",function(e){e.preventDefault();e.returnValue=""});</script>',

  '/download': '<a id=d download="probe.txt" href="/file.txt" style="font-size:30px">get it</a>'
    + '<script>setTimeout(function(){document.getElementById("d").click()},400)</script>',

  // A horizontally AND vertically scrollable box, for wheel/Shift+wheel.
  '/scroll': '<div id=box style="width:400px;height:300px;overflow:auto;border:2px solid #333">'
    + '<div style="width:3000px;height:3000px;background:'
    + 'repeating-linear-gradient(45deg,#eee 0 20px,#ccc 20px 40px)"></div></div>'
    + '<script>var b=document.getElementById("box");'
    + 'b.addEventListener("scroll",function(){R("scroll",b.scrollLeft+","+b.scrollTop)});'
    + '</script>',

  // Reports its own layout width. Real browser zoom SHRINKS the viewport in CSS
  // pixels, so innerWidth is the honest witness that zoom is not a fake scale.
  '/zoom': '<h1 id=h>zoom</h1><script>function go(){R("vw",innerWidth)}go();'
    + 'addEventListener("resize",go);</script>',

  // A slider, for drag.
  '/slider': '<input id=r type=range min=0 max=100 value=0 '
    + 'style="width:600px;height:60px;margin:60px"><div id=out>0</div>'
    + '<script>var r=document.getElementById("r");'
    + 'r.addEventListener("input",function(){'
    + 'document.getElementById("out").textContent=r.value;R("slider",r.value)});'
    + '</script>',

  // Plays a tone so the tab strip's audio indicator has something to indicate.
  '/audio': '<button id=b>go</button><script>'
    + 'function go(){var c=new AudioContext();var o=c.createOscillator();'
    + 'var g=c.createGain();g.gain.value=0.05;o.connect(g);g.connect(c.destination);'
    + 'o.start();}document.getElementById("b").onclick=go;setTimeout(go,300);</script>',

  // A focused textarea that reports what landed in it — the paste path.
  '/paste': '<textarea id=ta style="font-size:26px;width:90%;height:200px"></textarea>'
    + '<script>var ta=document.getElementById("ta");ta.focus();'
    + 'ta.addEventListener("input",function(){R("paste",ta.value)});</script>',

  '/title-a': '<title>Tab A</title><h1>A</h1>',
  '/title-b': '<title>Tab B</title><h1>B</h1>',

  // ── Pages for tools/probe-ui-controls.js (real clicks on the toolbar) ─────
  // Each one says WHICH page it is, every time it executes. That is the only
  // honest witness that Back actually went back: the address bar is written by
  // the client, so believing it would be believing the code under test. A page
  // that announces itself is the server-side truth.
  //
  // They are separate from /one|/two|/three on purpose — those are read by
  // probe-live-parity.js, and a probe that quietly changes another probe's
  // fixture is how a green run stops meaning anything.
  '/p1': '<title>P1</title><h1 id=p1>P1</h1><script>R("where","p1")</script>',
  '/p2': '<title>P2</title><h1 id=p2>P2</h1><script>R("where","p2")</script>',

  // Announces a NEW value on every execution. Reload has no other observable
  // outcome: the URL does not change, so "did the button do anything?" can only
  // be answered by the page telling us it ran again. `cache-control: no-store`
  // (set on every fixture response) also keeps this page out of the
  // back/forward cache, so a history navigation re-executes it rather than
  // restoring a frozen copy that would never report.
  '/nonce': '<title>N</title><h1 id=n>nonce</h1>'
    + '<script>R("nonce",String(Math.random()).slice(2,10)+"-"+Date.now())</script>',
};

// 1x1 transparent PNG — a real image body, and a real favicon.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A port this Chrome profile has almost certainly never held credentials for.
 *
 * Needed because Chrome's basic-auth credential cache is keyed by ORIGIN and
 * outlives both the server and the probe (the profile is persistent). See the
 * long note on `/secret`. A fresh port is a fresh origin, which is the only
 * thing measured to actually produce a second challenge.
 */
function freshPort() {
  // 41000-60999: above the fixture's default range, below the ephemeral range
  // Linux hands out by default (32768-60999 overlaps, so bind failures are
  // handled by the EADDRINUSE walk below anyway).
  return 41000 + Math.floor(Math.random() * 20000);
}

function start(port = 3111) {
  /** Latest value each page reported, keyed by name. */
  const reports = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;

    // A fixture page telling us what it sees.
    if (p === '/report') {
      reports.set(url.searchParams.get('k') || '?', url.searchParams.get('v') || '');
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }
    // The probe asking what the page saw.
    if (p === '/reports') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Object.fromEntries(reports)));
      return;
    }

    if (p === '/favicon.ico' || p === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(PIXEL);
      return;
    }

    // A real 401 challenge, so `Fetch.authRequired` really fires.
    //
    // MEASURED 2026-08-03 — and this one cost real time, so read it before
    // touching the auth checks.
    //
    // This project runs a PERSISTENT Chrome profile, and Chrome caches
    // basic-auth credentials for the life of that profile. Once a run has
    // authenticated to this fixture, later runs get NO challenge at all: Chrome
    // sends the Authorization header pre-emptively, the fixture answers 200, and
    // four auth checks fail reporting "no authRequired event" while the product
    // is behaving perfectly.
    //
    // The obvious mitigations do NOT work, and were each measured:
    //   • a fresh PATH (`/secret/<nonce>`)  → still pre-authenticated
    //   • a fresh REALM in WWW-Authenticate → still pre-authenticated
    // The server-side log below (`secretHits`) showed `pre-auth-ok` for a path
    // and realm Chrome had never seen, which means the credential cache is keyed
    // by ORIGIN, not by (origin, realm) as is commonly assumed. Worse, the cache
    // outlives a server restart because the PROFILE outlives it.
    //
    // So the only thing that actually re-challenges is a NEW ORIGIN. The fixture
    // therefore listens on a fresh port per probe run (see `start()`), and
    // 127.0.0.1:<newport> is an origin this profile has never held credentials
    // for. `secretHits` is kept so this can never silently regress into a
    // mystery again: it records, per request, whether the browser arrived
    // anonymous (a real challenge) or pre-authenticated (a cache hit).
    if (p === '/secret' || p.startsWith('/secret/')) {
      const nonce = p.startsWith('/secret/') ? p.slice('/secret/'.length) : 'static';
      const auth = req.headers.authorization || '';
      const want = 'Basic ' + Buffer.from('probeuser:probepass').toString('base64');
      // Record what the SERVER saw. "No prompt appeared" has two very different
      // causes — the browser never got a challenge, or the browser answered the
      // challenge from its own credential cache without asking anyone — and only
      // the server can tell them apart. `secretHits` grows one entry per
      // request: `pre-auth` means Chrome sent credentials unprompted.
      reports.set('secretHits',
        (reports.get('secretHits') ? reports.get('secretHits') + ';' : '')
        + p + '=' + (auth ? (auth === want ? 'pre-auth-ok' : 'pre-auth-bad') : 'anonymous'));
      if (auth !== want) {
        res.writeHead(401, {
          'www-authenticate': `Basic realm="Probe Realm ${nonce}"`,
          'content-type': 'text/html; charset=utf-8',
        });
        res.end('<h1>401</h1>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1 id=secret>AUTHENTICATED</h1>');
      return;
    }

    // A real attachment, so `page.on('download')` really fires.
    if (p === '/file.txt') {
      const body = 'downloaded bytes from the fixture server\n';
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="probe.txt"',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    const body = PAGES[p];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><meta charset=utf-8><link rel=icon href="/favicon.ico">'
      + BEACON + body);
  });

  return new Promise((resolve, reject) => {
    // A probe that crashed mid-run can leave the previous fixture holding the
    // port. Walking up a few ports is friendlier than making the operator hunt
    // a stray pid — and the probe learns the real base URL from us anyway.
    let attempt = 0;
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && attempt < 20) {
        attempt += 1;
        setTimeout(() => server.listen(port + attempt, '127.0.0.1'), 30);
        return;
      }
      reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      base: `http://127.0.0.1:${server.address().port}`,
      /** What a fixture page last reported for `k`. */
      report: (k) => reports.get(k),
      reports,
      reset: () => reports.clear(),
      /**
       * Stop listening AND drop live sockets.
       *
       * MEASURED 2026-08-03: `server.close(cb)` alone hangs forever here, and it
       * hung a whole probe run. Node's `close()` stops accepting new connections
       * but waits for existing ones to end, and Chrome keeps an idle keep-alive
       * socket open to every origin it has visited. So closing a fixture the
       * browser had just used never called back, the probe stalled at that exact
       * line, and nothing in the log said why. `closeAllConnections()` (Node 18.2+)
       * is what makes the promise actually settle; the timeout is a belt-and-braces
       * guarantee that a fixture teardown can never again be the thing that hangs
       * a measurement.
       */
      close: () => new Promise((r) => {
        let done = false;
        const finish = () => { if (!done) { done = true; r(); } };
        server.close(finish);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        setTimeout(finish, 2000).unref?.();
      }),
    }));
  });
}

module.exports = { start, freshPort };

if (require.main === module) {
  start(Number(process.argv[2]) || 3111).then((s) => {
    console.log('fixture server on ' + s.base);
  });
}
