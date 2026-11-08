// Tiny PDF checks without a PDF library: page count and the document title from the Info dictionary
export function pdfInfo(buf) {
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  let title = null;
  const hex = /\/Title\s*<([0-9A-Fa-f\s]+)>/.exec(s);
  const lit = /\/Title\s*\(((?:\\.|[^\\)])*)\)/.exec(s);
  const utf16 = (bytes) => {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    return Buffer.from(bytes).toString('latin1');
  };
  if (hex) title = utf16(Buffer.from(hex[1].replace(/\s+/g, ''), 'hex'));
  else if (lit) {
    const raw = lit[1].replace(/\\([0-7]{1,3}|.)/g, (m, c) => (/^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c)));
    title = utf16(Buffer.from(raw, 'latin1'));
  }
  return { isPdf: s.startsWith('%PDF-'), pages, title, bytes: buf.length };
}
