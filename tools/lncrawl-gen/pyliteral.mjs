// Minimal parser for the Python literals found in lncrawl crawler class bodies:
// strings (incl. r"" and implicit concatenation), True/False/None, numbers, lists, tuples, sets and dicts.

export class PyParseError extends Error {}

export function parseLiteral(src, start = 0) {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < src.length && /[\s]/.test(src[i])) i++;
      if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
      else break;
    }
  };

  function str() {
    let raw = false;
    if (/[rRuUbBfF]/.test(src[i]) && /["']/.test(src[i + 1] ?? '')) {
      if (/[fF]/.test(src[i])) throw new PyParseError('f-string');
      raw = /[rR]/.test(src[i]);
      i++;
    }
    const q = src[i];
    const triple = src.startsWith(q.repeat(3), i);
    const end = triple ? q.repeat(3) : q;
    i += end.length;
    let out = '';
    while (i < src.length && !src.startsWith(end, i)) {
      if (src[i] === '\\') {
        const n = src[i + 1];
        if (raw) {
          out += '\\' + n;
        } else {
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '\n': '' };
          out += n in map ? map[n] : '\\' + n;
        }
        i += 2;
      } else {
        out += src[i++];
      }
    }
    if (i >= src.length) throw new PyParseError('unterminated string');
    i += end.length;
    return out;
  }

  function value() {
    ws();
    const c = src[i];
    if (c === undefined) throw new PyParseError('eof');
    if (/["']/.test(c) || (/[rRuUbB]/.test(c) && /["']/.test(src[i + 1] ?? ''))) {
      let s = str();
      for (;;) {
        const save = i;
        ws();
        if (/["']/.test(src[i] ?? '') || (/[rRuUbB]/.test(src[i] ?? '') && /["']/.test(src[i + 1] ?? ''))) s += str();
        else {
          i = save;
          break;
        }
      }
      return s;
    }
    if (c === '[' || c === '(' || c === '{') {
      const close = { '[': ']', '(': ')', '{': '}' }[c];
      i++;
      const items = [];
      let isDict = false;
      const dict = {};
      for (;;) {
        ws();
        if (src[i] === close) {
          i++;
          break;
        }
        const k = value();
        ws();
        if (c === '{' && src[i] === ':') {
          i++;
          isDict = true;
          dict[String(k)] = value();
        } else items.push(k);
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== close) throw new PyParseError(`unexpected ${src[i]}`);
      }
      return isDict ? dict : items;
    }
    const m = /^(True|False|None|-?\d+(?:\.\d+)?)\b/.exec(src.slice(i, i + 40));
    if (m) {
      i += m[0].length;
      return m[1] === 'True' ? true : m[1] === 'False' ? false : m[1] === 'None' ? null : Number(m[1]);
    }
    throw new PyParseError(`unsupported literal at ${JSON.stringify(src.slice(i, i + 20))}`);
  }

  const v = value();
  return { value: v, end: i };
}
