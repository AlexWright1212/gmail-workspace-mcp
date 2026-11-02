// A minimal, valid, single-page PDF with one line of Helvetica text, built
// by hand with a correct cross-reference table. Small on purpose (~600
// bytes): PDFs under 4 KB land in a POOLED Node Buffer (byteOffset != 0),
// which is exactly the shape that tripped pdf-parse's bundled pdf.js
// (`makeSubStream` reads `bytes.buffer` from an absolute offset and ignores
// `byteOffset`). Used by test/attachments.test.mjs and the live harness.
export function buildTinyPdf(sentence) {
  const objects = [];
  const add = (body) => objects.push(body);
  const stream = `BT /F1 18 Tf 72 720 Td (${sentence.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
