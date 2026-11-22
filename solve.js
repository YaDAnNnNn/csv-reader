// Faster drop-in replacement for csv-reader 1.0.0: run(input) returns exactly
// csv-reader's {columns, rows, errors} for every input, but reads the text with
// slice-based field extraction and indexOf-accelerated quote scanning instead
// of one character at a time. Pure: nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors carry these two, never the live line.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `prefix` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns
  // [value, ended, added]; `added` counts the characters kept by this call.
  function readUnquoted(prefix) {
    let segs = null;
    let added = 0;
    let segStart = pos;
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) { // ,
        const tail = text.slice(segStart, i);
        pos = i + 1;
        added += tail.length;
        return [segs ? segs.join("") + tail : prefix + tail, COMMA, added];
      }
      if (c === 10) { // LF
        const tail = text.slice(segStart, i);
        pos = i + 1;
        line += 1;
        added += tail.length;
        return [segs ? segs.join("") + tail : prefix + tail, LINE_BREAK, added];
      }
      if (c === 13) { // CR
        if (text.charCodeAt(i + 1) === 10) { // CRLF
          const tail = text.slice(segStart, i);
          pos = i + 2;
          line += 1;
          added += tail.length;
          return [segs ? segs.join("") + tail : prefix + tail, LINE_BREAK, added];
        }
        errors.push({ code: "stray_cr", line: recordLine, row: recordRow });
        if (!segs) segs = [prefix];
        segs.push(text.slice(segStart, i));
        added += i - segStart;
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    const tail = text.slice(segStart, n);
    pos = n;
    added += tail.length;
    return [segs ? segs.join("") + tail : prefix + tail, END, added];
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    const parts = [];
    let segStart = pos;
    let i = pos;
    let closed = false;

    // Appends text[a..b) of quoted content to `parts`, reading each CRLF or
    // lone CR as one LF and counting every line break in the span.
    function appendChunk(a, b) {
      let r = text.indexOf("\r", a);
      if (r === -1 || r >= b) {
        for (let j = a; j < b; j++) if (text.charCodeAt(j) === 10) line += 1;
        if (b > a) parts.push(text.slice(a, b));
        return;
      }
      let start = a;
      while (r !== -1 && r < b) {
        for (let j = start; j < r; j++) if (text.charCodeAt(j) === 10) line += 1;
        if (r > start) parts.push(text.slice(start, r));
        parts.push("\n");
        line += 1;
        start = r + 1;
        if (text.charCodeAt(start) === 10) start += 1; // the LF of a CRLF
        r = text.indexOf("\r", start);
      }
      for (let j = start; j < b; j++) if (text.charCodeAt(j) === 10) line += 1;
      if (b > start) parts.push(text.slice(start, b));
    }

    while (i < n) {
      const q = text.indexOf('"', i);
      if (q === -1) { i = n; break; }
      if (text.charCodeAt(q + 1) === 34) { // doubled quote: one literal quote
        appendChunk(segStart, q);
        parts.push('"');
        i = q + 2;
        segStart = i;
        continue;
      }
      appendChunk(segStart, q);
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: "unterminated_quote", line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const value = parts.length === 1 ? parts[0] : parts.join("");
    if (pos >= n) return [value, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; return [value, COMMA, 0]; }
    if (c === 10) { pos += 1; line += 1; return [value, LINE_BREAK, 0]; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break (quote_junk, when the field ends).
    const junk = readUnquoted(value);
    if (junk[2] > 0) errors.push({ code: "quote_junk", line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted("");
      fields.push(field[0]);
    } while (field[1] === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === "" && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: "short_row", line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push("");
    } else if (fields.length > width) {
      errors.push({ code: "long_row", line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
