/*
 * expression.js — light, SAFE n8n-style expression engine (Step 25).
 *
 * Pure, DOM-free, CSP-safe. No framework, no DOM. Unit-tested under node:vm
 * with only a `window` shim (the Step 23/24 lesson).
 *
 * SECURITY (the n8n CVE lesson — CVE-2025-xxxx style sandbox escapes):
 *   This engine NEVER uses eval() / new Function() / with(). It is a small
 *   tokenizer + Pratt parser + tree-walking interpreter over a STRICT, tiny
 *   grammar. The only reachable values are the explicit context variables
 *   ($json/$node/$now/$today/$index/$vars) plus literals; member access blocks
 *   __proto__/prototype/constructor; method calls are limited to a per-type
 *   WHITELIST. There is no path to globalThis, process, require, Function, etc.
 *
 * SUPPORTED SURFACE
 *   Template:   "Hello {{ $json.name }}, page {{ $index + 1 }}"
 *   Variables:  $json  $node["Name"].json.x  $now  $today  $index  $vars.x
 *   Literals:   'str'  "str"  123  1.5  true  false  null
 *   Operators:  + - * / %   == != === !==   < > <= >=   && ||   ! (unary)  -unary
 *               ?: ternary    () grouping     [ ] index     . member
 *   Arrays:     [1, 2, $json.x]
 *   Calls:      String(x) Number(x) Boolean(x) Math.max(a,b) JSON.stringify(x)
 *               and whitelisted METHODS: ('s').toUpperCase(), arr.length, etc.
 *
 * Exposes window.ExpressionEngine = {
 *   isExpression(str), evaluate(str, ctx), evaluateTemplate(str, ctx),
 *   mapParams(params, ctx, fieldMeta)
 * }
 *
 * Loaded BEFORE flow-editor.js in index.html. LF line endings.
 */
(function () {
  'use strict';

  // ===== blocked property names (prototype-pollution / sandbox escape) =======
  var BLOCKED_KEYS = {
    __proto__: true, prototype: true, constructor: true,
    __defineGetter__: true, __defineSetter__: true, __lookupGetter__: true,
    __lookupSetter__: true,
  };

  // ===== method whitelist per value kind =====================================
  var STRING_METHODS = {
    toUpperCase: 1, toLowerCase: 1, trim: 1, trimStart: 1, trimEnd: 1,
    slice: 1, substring: 1, substr: 1, charAt: 1, indexOf: 1, lastIndexOf: 1,
    includes: 1, startsWith: 1, endsWith: 1, split: 1, replace: 1,
    replaceAll: 1, padStart: 1, padEnd: 1, repeat: 1, concat: 1,
  };
  var ARRAY_METHODS = {
    slice: 1, indexOf: 1, lastIndexOf: 1, includes: 1, join: 1, concat: 1,
    // safe, non-callback array helpers only (no map/filter -> no user fn exec)
    flat: 1, reverse: 1, at: 1,
  };
  var NUMBER_METHODS = { toFixed: 1, toPrecision: 1, toString: 1 };

  // Whitelisted free functions / namespaces.
  function makeGlobals() {
    var MathNS = {};
    ['abs', 'ceil', 'floor', 'round', 'trunc', 'max', 'min', 'pow', 'sqrt', 'sign', 'random'].forEach(function (k) {
      MathNS[k] = Math[k];
    });
    var JSONNS = {
      stringify: function (v) { try { return JSON.stringify(v); } catch (e) { return ''; } },
      parse: function (s) { try { return JSON.parse(String(s)); } catch (e) { return null; } },
    };
    return {
      String: function (v) { return String(v == null ? '' : v); },
      Number: function (v) { var n = Number(v); return isNaN(n) ? 0 : n; },
      Boolean: function (v) { return Boolean(v); },
      Math: MathNS,
      JSON: JSONNS,
    };
  }

  // ===== tokenizer ===========================================================
  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;
    function isIdStart(c) { return /[A-Za-z_$]/.test(c); }
    function isIdPart(c) { return /[A-Za-z0-9_$]/.test(c); }
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      // string
      if (c === '"' || c === "'") {
        var quote = c; var s = ''; i++;
        while (i < n && src[i] !== quote) {
          if (src[i] === '\\' && i + 1 < n) {
            var e = src[i + 1];
            s += (e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e);
            i += 2;
          } else { s += src[i]; i++; }
        }
        if (i >= n) throw new Error('Unterminated string');
        i++; // closing quote
        tokens.push({ t: 'str', v: s });
        continue;
      }
      // number
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
        var num = '';
        while (i < n && /[0-9.]/.test(src[i])) { num += src[i]; i++; }
        tokens.push({ t: 'num', v: parseFloat(num) });
        continue;
      }
      // identifier / keyword
      if (isIdStart(c)) {
        var id = '';
        while (i < n && isIdPart(src[i])) { id += src[i]; i++; }
        if (id === 'true') tokens.push({ t: 'bool', v: true });
        else if (id === 'false') tokens.push({ t: 'bool', v: false });
        else if (id === 'null') tokens.push({ t: 'null', v: null });
        else tokens.push({ t: 'id', v: id });
        continue;
      }
      // multi-char operators
      var three = src.substr(i, 3);
      if (three === '===' || three === '!==') { tokens.push({ t: 'op', v: three }); i += 3; continue; }
      var two = src.substr(i, 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].indexOf(two) !== -1) {
        tokens.push({ t: 'op', v: two }); i += 2; continue;
      }
      if ('+-*/%<>!?:.,()[]'.indexOf(c) !== -1) {
        tokens.push({ t: 'op', v: c }); i++; continue;
      }
      throw new Error('Unexpected character: ' + c);
    }
    tokens.push({ t: 'eof', v: null });
    return tokens;
  }

  // ===== parser (Pratt) ======================================================
  function parse(tokens) {
    var pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function expect(v) {
      var tk = next();
      if (tk.v !== v) throw new Error('Expected "' + v + '" but got "' + tk.v + '"');
      return tk;
    }

    // binary operator precedence
    var PREC = {
      '||': 1, '&&': 2,
      '==': 3, '!=': 3, '===': 3, '!==': 3,
      '<': 4, '>': 4, '<=': 4, '>=': 4,
      '+': 5, '-': 5,
      '*': 6, '/': 6, '%': 6,
    };

    function parseExpression() { return parseTernary(); }

    function parseTernary() {
      var cond = parseBinary(0);
      if (peek().t === 'op' && peek().v === '?') {
        next();
        var cons = parseExpression();
        expect(':');
        var alt = parseExpression();
        return { type: 'ternary', cond: cond, cons: cons, alt: alt };
      }
      return cond;
    }

    function parseBinary(minPrec) {
      var left = parseUnary();
      while (peek().t === 'op' && PREC[peek().v] && PREC[peek().v] > minPrec) {
        var op = next().v;
        var right = parseBinary(PREC[op]);
        left = { type: 'binary', op: op, left: left, right: right };
      }
      return left;
    }

    function parseUnary() {
      if (peek().t === 'op' && (peek().v === '!' || peek().v === '-')) {
        var op = next().v;
        return { type: 'unary', op: op, arg: parseUnary() };
      }
      return parsePostfix();
    }

    function parsePostfix() {
      var node = parsePrimary();
      while (true) {
        var tk = peek();
        if (tk.t === 'op' && tk.v === '.') {
          next();
          var prop = next();
          if (prop.t !== 'id') throw new Error('Expected property name');
          node = { type: 'member', obj: node, prop: { type: 'lit', value: prop.v }, computed: false };
        } else if (tk.t === 'op' && tk.v === '[') {
          next();
          var idx = parseExpression();
          expect(']');
          node = { type: 'member', obj: node, prop: idx, computed: true };
        } else if (tk.t === 'op' && tk.v === '(') {
          next();
          var args = [];
          if (!(peek().t === 'op' && peek().v === ')')) {
            args.push(parseExpression());
            while (peek().t === 'op' && peek().v === ',') { next(); args.push(parseExpression()); }
          }
          expect(')');
          node = { type: 'call', callee: node, args: args };
        } else {
          break;
        }
      }
      return node;
    }

    function parsePrimary() {
      var tk = next();
      if (tk.t === 'num') return { type: 'lit', value: tk.v };
      if (tk.t === 'str') return { type: 'lit', value: tk.v };
      if (tk.t === 'bool') return { type: 'lit', value: tk.v };
      if (tk.t === 'null') return { type: 'lit', value: null };
      if (tk.t === 'id') return { type: 'ident', name: tk.v };
      if (tk.t === 'op' && tk.v === '(') {
        var e = parseExpression();
        expect(')');
        return e;
      }
      if (tk.t === 'op' && tk.v === '[') {
        var els = [];
        if (!(peek().t === 'op' && peek().v === ']')) {
          els.push(parseExpression());
          while (peek().t === 'op' && peek().v === ',') { next(); els.push(parseExpression()); }
        }
        expect(']');
        return { type: 'array', elements: els };
      }
      throw new Error('Unexpected token: ' + tk.v);
    }

    var ast = parseExpression();
    if (peek().t !== 'eof') throw new Error('Unexpected trailing token: ' + peek().v);
    return ast;
  }

  // ===== evaluator ===========================================================
  function safeKey(key) {
    var k = String(key);
    if (BLOCKED_KEYS[k]) throw new Error('Access to "' + k + '" is not allowed');
    return k;
  }

  // Determine the method whitelist for a receiver value.
  function methodAllowed(receiver, name) {
    if (typeof receiver === 'string') return !!STRING_METHODS[name];
    if (Array.isArray(receiver)) return !!ARRAY_METHODS[name];
    if (typeof receiver === 'number') return !!NUMBER_METHODS[name];
    return false;
  }

  function evalNode(node, scope) {
    switch (node.type) {
      case 'lit': return node.value;
      case 'array': return node.elements.map(function (e) { return evalNode(e, scope); });
      case 'ident': {
        var name = node.name;
        if (Object.prototype.hasOwnProperty.call(scope.vars, name)) return scope.vars[name];
        if (Object.prototype.hasOwnProperty.call(scope.globals, name)) return scope.globals[name];
        throw new Error('Unknown identifier: ' + name);
      }
      case 'unary': {
        var v = evalNode(node.arg, scope);
        if (node.op === '!') return !v;
        return -Number(v);
      }
      case 'binary': {
        var op = node.op;
        if (op === '&&') return evalNode(node.left, scope) && evalNode(node.right, scope);
        if (op === '||') return evalNode(node.left, scope) || evalNode(node.right, scope);
        var l = evalNode(node.left, scope);
        var r = evalNode(node.right, scope);
        switch (op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          case '%': return l % r;
          case '==': return l == r; // eslint-disable-line eqeqeq
          case '!=': return l != r; // eslint-disable-line eqeqeq
          case '===': return l === r;
          case '!==': return l !== r;
          case '<': return l < r;
          case '>': return l > r;
          case '<=': return l <= r;
          case '>=': return l >= r;
        }
        throw new Error('Unknown operator: ' + op);
      }
      case 'ternary':
        return evalNode(node.cond, scope) ? evalNode(node.cons, scope) : evalNode(node.alt, scope);
      case 'member': {
        var obj = evalNode(node.obj, scope);
        var key = node.computed ? evalNode(node.prop, scope) : node.prop.value;
        if (obj == null) return undefined;
        key = safeKey(key);
        // string/array .length is fine; method references are resolved at call.
        var val = obj[key];
        return val;
      }
      case 'call': {
        // Only allow calling: (a) a member on a whitelisted receiver type, or
        // (b) a whitelisted global function (Math.x / String / Number / ...).
        var callee = node.callee;
        var args = node.args.map(function (a) { return evalNode(a, scope); });
        if (callee.type === 'member') {
          var receiver = evalNode(callee.obj, scope);
          var name = callee.computed ? String(evalNode(callee.prop, scope)) : callee.prop.value;
          name = safeKey(name);
          // global namespace methods (Math.*, JSON.*)
          if (receiver === scope.globals.Math || receiver === scope.globals.JSON) {
            var gfn = receiver[name];
            if (typeof gfn !== 'function') throw new Error('Not a function: ' + name);
            return gfn.apply(null, args);
          }
          if (!methodAllowed(receiver, name)) {
            throw new Error('Method not allowed: ' + name);
          }
          var fn = receiver[name];
          if (typeof fn !== 'function') throw new Error('Not a function: ' + name);
          return fn.apply(receiver, args);
        }
        if (callee.type === 'ident') {
          var g = scope.globals[callee.name];
          if (typeof g !== 'function') throw new Error('Not a callable: ' + callee.name);
          return g.apply(null, args);
        }
        throw new Error('Invalid call target');
      }
    }
    throw new Error('Unknown node type: ' + node.type);
  }

  // ===== context / scope =====================================================
  function buildScope(ctx) {
    ctx = ctx || {};
    // Duck-type the Date (instanceof fails across node:vm / iframe realms).
    var now = ctx.now && typeof ctx.now.toISOString === 'function' ? ctx.now : new Date();
    var vars = {
      $json: ctx.json || {},
      $node: ctx.node || {},
      $vars: ctx.vars || {},
      $index: typeof ctx.index === 'number' ? ctx.index : 0,
      $now: now.toISOString(),
      $today: now.toISOString().slice(0, 10),
    };
    return { vars: vars, globals: makeGlobals() };
  }

  // ===== public API ==========================================================
  // A value is an "expression" when it contains a {{ ... }} template.
  function isExpression(str) {
    return typeof str === 'string' && /\{\{[\s\S]*?\}\}/.test(str);
  }

  // Evaluate a single expression body (no surrounding {{ }}). Throws on error.
  function evaluate(body, ctx) {
    var ast = parse(tokenize(String(body)));
    return evalNode(ast, buildScope(ctx));
  }

  // Evaluate a full template string, replacing each {{ ... }} with its result.
  // If the WHOLE string is a single expression, the native (non-string) result
  // type is preserved (so {{ $json.count }} can yield a number).
  function evaluateTemplate(str, ctx) {
    if (typeof str !== 'string') return str;
    if (!isExpression(str)) return str;
    var whole = str.match(/^\s*\{\{([\s\S]*?)\}\}\s*$/);
    if (whole) {
      return evaluate(whole[1], ctx);
    }
    return str.replace(/\{\{([\s\S]*?)\}\}/g, function (_, body) {
      var v = evaluate(body, ctx);
      return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
  }

  // Map a params object: any string value containing {{ }} is evaluated against
  // ctx. Non-expression values pass through unchanged. Never throws — a failed
  // expression resolves to its raw text (so the backend sees something sane and
  // the UI can flag it). Returns { params, errors:{key:message} }.
  function mapParams(params, ctx) {
    var out = {};
    var errors = {};
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (isExpression(v)) {
        try { out[k] = evaluateTemplate(v, ctx); }
        catch (e) { out[k] = v; errors[k] = e.message; }
      } else {
        out[k] = v;
      }
    });
    return { params: out, errors: errors };
  }

  window.ExpressionEngine = {
    isExpression: isExpression,
    evaluate: evaluate,
    evaluateTemplate: evaluateTemplate,
    mapParams: mapParams,
  };
})();
