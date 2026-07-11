/**
 * TEST-ONLY minimal deterministic PDF builder (S3). Builds tiny, valid, SELF-MADE PDF bytes
 * (no downloaded/internet fixtures — licensing/PII/determinism, the founder-confirmed posture) for
 * the parse-node arms: text-layer pages, empty-content (no-text-layer) pages, many-page bomb
 * shapes, and an encrypted shape pdf.js must refuse without a password. The committed
 * `__fixtures__/text-layer.pdf` / `__fixtures__/no-text-layer.pdf` were generated with exactly
 * `buildPdf({pages:[{text:'Hello RaySpec PDF fixture.'}]})` / `buildPdf({pages:[{}]})`.
 * Cross-reference offsets are COMPUTED (never hand-typed), so the bytes stay structurally valid.
 */

export interface PdfFixturePage {
  /** A page with `text` gets a one-line BT/Tj text layer; without, an EMPTY content stream. */
  readonly text?: string;
}

/** Build a minimal valid single-xref PDF (latin1 bytes) from the page list. */
export function buildPdf(opts: { readonly pages: readonly PdfFixturePage[] }): Uint8Array {
  const objects: string[] = [];
  const pageCount = opts.pages.length;
  // obj 1: catalog · obj 2: pages tree · obj 3: font · page i ⇒ obj 4+2i, its content ⇒ obj 5+2i.
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  const kids = opts.pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  opts.pages.forEach((page, i) => {
    const pageNum = 4 + 2 * i;
    const contentNum = 5 + 2 * i;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = page.text
      ? `BT /F1 12 Tf 72 720 Td (${page.text.replace(/([\\()])/g, '\\$1')}) Tj ET`
      : ``;
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

  let body = `%PDF-1.4\n`;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return latin1Bytes(body + xref + trailer);
}

/**
 * An ENCRYPTED-PDF shape: the minimal PDF with a standard-security-handler `/Encrypt` dict spliced
 * into the trailer whose `/U` value can never verify an empty user password — pdf.js MUST refuse it
 * (`PasswordException`, name-pinned by the unit arm). Empirically verified against unpdf 1.6.2
 * (pdf.js 5.6.205): rejects with `name='PasswordException'`, message 'No password given'.
 */
export function buildEncryptedPdfShape(): Uint8Array {
  const base = latin1String(buildPdf({ pages: [{ text: 'secret' }] }));
  const o = 'a'.repeat(32);
  const u = 'b'.repeat(32);
  const spliced = base.replace(
    /trailer\n<< \/Size (\d+) \/Root 1 0 R >>/,
    `trailer\n<< /Size $1 /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O (${o}) /U (${u}) /P -44 >> >>`,
  );
  if (spliced === base) throw new Error('encrypted-shape splice did not match the trailer');
  return latin1Bytes(spliced);
}

function latin1Bytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

function latin1String(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
