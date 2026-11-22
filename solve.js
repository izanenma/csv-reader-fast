// fast-csv: a faster drop-in for make.fun's csv-reader 1.0.0.
//
// It returns exactly csv-reader's answer for every input {text, header}:
// {columns, rows, errors}, with the same broken-row policy and the same
// errors in the same order. It is only faster:
//
//   - A field is never built a character at a time. An unquoted field ends
//     at the next comma or line break found by indexOf, and is sliced once.
//     A quoted field jumps from quote to quote the same way, and is sliced
//     once when it holds no doubled quote and no line break.
//   - A record that holds no quote and no CR is split whole by ','.
//   - The only character loop left is the rare broken-field path (a stray
//     CR inside a field, a quote that never closes, junk after a quote).
//   - Errors keep csv-reader's shape and order: stray_cr where a lone CR
//     is dropped, unterminated_quote where a quote never closes,
//     quote_junk where characters follow a closing quote, short_row and
//     long_row where a record is narrower or wider than the first.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Fields stay strings, never trimmed or converted.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors name these, not where they are found.
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field onto `value` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr) on the slow path.
  // Returns the field and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    const comma = text.indexOf(',', pos);
    const nl = text.indexOf('\n', pos);
    const c = comma === -1 ? len : comma;
    const n = nl === -1 ? len : nl;
    if (c < n) {
      const v = text.slice(pos, c);
      if (v.indexOf('\r') === -1) {
        pos = c + 1;
        return { value: value + v, ended: COMMA, added: v.length };
      }
      return readUnquotedSlow(value, added);
    }
    if (n === len) {
      const v = text.slice(pos, len);
      if (v.indexOf('\r') === -1) {
        pos = len;
        return { value: value + v, ended: END, added: v.length };
      }
      return readUnquotedSlow(value, added);
    }
    if (n > pos && text.charCodeAt(n - 1) === 13) {
      const v = text.slice(pos, n - 1);
      if (v.indexOf('\r') === -1) {
        pos = n + 1;
        line += 1;
        return { value: value + v, ended: BREAK, added: v.length };
      }
      return readUnquotedSlow(value, added);
    }
    const v = text.slice(pos, n);
    if (v.indexOf('\r') === -1) {
      pos = n + 1;
      line += 1;
      return { value: value + v, ended: BREAK, added: v.length };
    }
    return readUnquotedSlow(value, added);
  }

  // The slow unquoted read, a character at a time, for a field that holds
  // a stray CR: the CR is dropped (stray_cr) and the rest is read as usual.
  function readUnquotedSlow(value, added) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: BREAK, added };
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: BREAK, added };
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    let closedAt = -1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, q));
        parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      closedAt = q;
      break;
    }
    // The quoted span holds no doubled quote past here; build the value.
    let raw = parts === null ? text.slice(open + 1, closedAt) : parts.join('') + text.slice(segStart, closedAt);
    let value = raw;
    // Each CRLF or lone CR inside the quotes is one LF, and counts a line.
    if (raw.indexOf('\r') !== -1 || raw.indexOf('\n') !== -1) {
      let breaks = 0;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 10) breaks += 1;
        else if (c === 13) {
          breaks += 1;
          if (raw.charCodeAt(i + 1) === 10) i += 1;
        }
      }
      line += breaks;
      value = raw.replace(/\r\n?/g, '\n');
    }
    pos = closedAt + 1;
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // A record's fields once read: the first record sets the width, the
  // header is kept as columns, the rest are padded or cut to the width.
  function commit(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // A record with no quote and no CR splits whole.
    const recEnd = text.indexOf('\n', pos);
    const re = recEnd === -1 ? len : recEnd;
    const rec = text.slice(pos, re);
    let body = rec;
    if (re < len && rec.charCodeAt(rec.length - 1) === 13) body = rec.slice(0, -1);
    if (body.indexOf('"') === -1 && body.indexOf('\r') === -1) {
      const fields = body.split(',');
      pos = re < len ? re + 1 : len;
      if (re < len) line += 1;
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (!(fields.length === 1 && fields[0] === '')) commit(fields);
      continue;
    }

    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    commit(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
