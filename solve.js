// A fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
//
// Written from the reference's published policy (kit RULES.txt): the text is read once,
// left to right, and run(input) answers {columns, rows, errors} exactly as csv-reader
// 1.0.0 does for {text, header}:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote and each CRLF or lone CR inside it read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line its record
//     starts on, counting every LF, CRLF and lone CR inside quotes, and row its record's
//     index in rows, null for the header.
//
// Speed comes from searching for delimiters with indexOf (native, memchr-speed scans)
// instead of reading one character at a time, and from slicing fields out of the text
// instead of building them up character by character. Texts with no quote at all take a
// split-based path. No dependencies, no state kept from one call to the next.

/** Line breaks inside a quoted field: CRLF counts once, as does a lone CR or LF. */
const BREAKS = /\r\n?|\n/g;
/** A CR or CRLF inside a quoted field, each read as LF. */
const CR_ONLY = /\r\n?/g;
/** Doubled quotes inside a quoted field. */
const DOUBLED = /""/g;

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/**
 * csv-reader 1.0.0's answer for one case's input, {text, header}:
 * {columns, rows, errors}.
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  // No quote anywhere: no field can span lines, so split the text into lines and
  // split each line on commas. (A quote inside an unquoted field is literal, so a
  // text with a quote anywhere takes the general path below.)
  if (text.indexOf('"') === -1) return runNoQuote(text, header);
  return runGeneral(text, header);
}

/** The reading of a text with no quote in it. */
function runNoQuote(text, header) {
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const lines = text.split('\n');
  if (lines.length !== 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);

  for (let li = 0; li < lines.length; li++) {
    let seg = lines[li];
    const last = li === lines.length - 1;
    const recordLine = li + 1;
    const recordRow = header && columns === null ? null : rows.length;
    // A line ending in CR was ended by CRLF: the CR is the break, not a stray one.
    // (The last line has no LF after it, so a CR ending it is a lone one.)
    if (!last && seg.charCodeAt(seg.length - 1) === 13) seg = seg.slice(0, -1);
    if (seg.indexOf('\r') !== -1) {
      // Every CR left here is a lone one: dropped, one stray_cr error each.
      const parts = seg.split('\r');
      for (let k = 1; k < parts.length; k++) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      seg = parts.join('');
    }
    if (seg === '') continue; // a line left with no characters is no record
    const fields = seg.split(',');
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

/** The reading of a text that holds at least one quote. */
function runGeneral(text, header) {
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  const hasCR = text.indexOf('\r') !== -1;
  // Index of the next CR at or after pos, -1 when none is left; recomputed lazily
  // whenever pos passes it, so the CR search never re-scans ground already covered.
  let nextCR = -2;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len !== 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes
  // (null: the header). Every error a record meets carries these two.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). Returns the field, how it ended, and
  // how many characters were kept (`added`).
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      if (!hasCR) {
        const dC = text.indexOf(',', pos);
        const dN = text.indexOf('\n', pos);
        if (dC === -1 && dN === -1) {
          value += text.slice(pos);
          added += len - pos;
          pos = len;
          return { value, ended: END, added };
        }
        if (dC !== -1 && (dN === -1 || dC < dN)) {
          value += text.slice(pos, dC);
          added += dC - pos;
          pos = dC + 1;
          return { value, ended: COMMA, added };
        }
        value += text.slice(pos, dN);
        added += dN - pos;
        pos = dN + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (nextCR !== -1 && nextCR < pos) nextCR = text.indexOf('\r', pos);
      const dC2 = text.indexOf(',', pos);
      const dN2 = text.indexOf('\n', pos);
      let m; let kind;
      if (dC2 === -1 && dN2 === -1) { m = len; kind = 2; }
      else if (dC2 !== -1 && (dN2 === -1 || dC2 < dN2)) { m = dC2; kind = 0; }
      else { m = dN2; kind = 1; }
      if (nextCR !== -1 && nextCR < m) {
        if (nextCR === m - 1 && kind === 1) {
          // CRLF: the CR belongs to the line break.
          value += text.slice(pos, nextCR);
          added += nextCR - pos;
          pos = m + 1;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        // A lone CR: dropped (stray_cr) and the field goes on.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += text.slice(pos, nextCR);
        added += nextCR - pos;
        pos = nextCR + 1;
        continue;
      }
      if (kind === 2) {
        value += text.slice(pos);
        added += len - pos;
        pos = len;
        return { value, ended: END, added };
      }
      value += text.slice(pos, m);
      added += m - pos;
      if (kind === 0) {
        pos = m + 1;
        return { value, ended: COMMA, added };
      }
      pos = m + 1;
      line += 1;
      return { value, ended: LINE_BREAK, added };
    }
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

    // The record being read: the line it starts on and the index in rows it takes
    // (null: the header). Every error this record meets carries these two.
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      let value;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        // Find the closing quote: the next quote that is not doubled.
        let close = -1;
        let hasEscaped = false;
        let i = pos + 1;
        for (;;) {
          i = text.indexOf('"', i);
          if (i === -1) break;
          if (text.charCodeAt(i + 1) === 34) {
            hasEscaped = true;
            i += 2;
            continue;
          }
          close = i;
          break;
        }
        if (close === -1) {
          // The quote never closes: it is a literal character, and the text after
          // it is read again as unquoted. (line is untouched by the search above,
          // so it still stands at the opening quote's line, as the reference has it.)
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          // The re-read starts just after the opening quote.
          pos = open + 1;
          const f = readUnquoted('"');
          value = f.value;
          ended = f.ended;
        } else {
          const seg = text.slice(open + 1, close);
          if (!hasEscaped && seg.indexOf('\r') === -1) {
            value = seg;
            if (seg.indexOf('\n') !== -1) {
              let n = 0;
              let k = -1;
              while ((k = seg.indexOf('\n', k + 1)) !== -1) n += 1;
              line += n;
            }
          } else {
            // CRLF and lone CRs inside quotes each read as LF; "" reads as one quote.
            const breaks = seg.match(BREAKS);
            if (breaks !== null) line += breaks.length;
            value = seg.replace(CR_ONLY, '\n');
            if (hasEscaped) value = value.replace(DOUBLED, '"');
          }
          pos = close + 1;
          if (pos >= len) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up to the
              // next comma or line break.
              const junk = readUnquoted(value);
              if (junk.added > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
              value = junk.value;
              ended = junk.ended;
            }
          }
        }
      } else {
        quoted = false;
        if (!hasCR) {
          const dC = text.indexOf(',', pos);
          const dN = text.indexOf('\n', pos);
          if (dC === -1 && dN === -1) {
            value = text.slice(pos);
            pos = len;
            ended = END;
          } else if (dC !== -1 && (dN === -1 || dC < dN)) {
            value = text.slice(pos, dC);
            pos = dC + 1;
            ended = COMMA;
          } else {
            value = text.slice(pos, dN);
            pos = dN + 1;
            line += 1;
            ended = LINE_BREAK;
          }
        } else {
          // Fast path: the next delimiter, unless a lone CR comes first.
          if (nextCR !== -1 && nextCR < pos) nextCR = text.indexOf('\r', pos);
          const dC = text.indexOf(',', pos);
          const dN = text.indexOf('\n', pos);
          let m; let kind;
          if (dC === -1 && dN === -1) { m = len; kind = 2; }
          else if (dC !== -1 && (dN === -1 || dC < dN)) { m = dC; kind = 0; }
          else { m = dN; kind = 1; }
          if (nextCR !== -1 && nextCR < m && !(nextCR === m - 1 && kind === 1)) {
            // A lone CR inside the field: drop it (stray_cr) and let readUnquoted
            // carry the field on from just past it.
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            const first = text.slice(pos, nextCR);
            pos = nextCR + 1;
            const f = readUnquoted(first);
            value = f.value;
            ended = f.ended;
          } else if (kind === 2) {
            value = text.slice(pos);
            pos = len;
            ended = END;
          } else if (kind === 0) {
            value = text.slice(pos, m);
            pos = m + 1;
            ended = COMMA;
          } else {
            // A line break: a CR just before the LF is the CRLF's, not a stray one.
            value = text.slice(pos, nextCR !== -1 && nextCR === m - 1 ? nextCR : m);
            pos = m + 1;
            line += 1;
            ended = LINE_BREAK;
          }
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its
    // stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
