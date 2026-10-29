import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRef } from 'pdf-lib';

/**
 * PDF-Hilfen für Nachweisdokumentationen (pdf-lib, MIT).
 */

export interface PdfInfo {
  pages: number;
  /** Alle Schriften eingebettet? Sonst ist die Rechnung mit diesem Anhang nicht mehr streng PDF/A-3. */
  fontsEmbedded: boolean;
}

/** Hochgeladene Datei prüfen; wirft bei ungültigen oder verschlüsselten PDFs. */
export async function inspectPdf(data: Uint8Array): Promise<PdfInfo> {
  if (Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('Keine PDF-Datei.');
  const doc = await PDFDocument.load(data, { updateMetadata: false }); // wirft bei Verschlüsselung
  return { pages: doc.getPageCount(), fontsEmbedded: allFontsEmbedded(doc) };
}

function allFontsEmbedded(doc: PDFDocument): boolean {
  const ctx = doc.context;
  const lookupDict = (v: unknown): PDFDict | undefined => {
    const obj = v instanceof PDFRef ? ctx.lookup(v) : v;
    return obj instanceof PDFDict ? obj : undefined;
  };
  const embedded = (font: PDFDict): boolean => {
    const subtype = font.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Type3')) return true;
    if (subtype === PDFName.of('Type0')) {
      const desc = font.get(PDFName.of('DescendantFonts'));
      const arr = desc instanceof PDFRef ? ctx.lookup(desc) : desc;
      if (!(arr instanceof PDFArray)) return false;
      return arr.asArray().every((d) => {
        const dict = lookupDict(d);
        return dict ? embedded(dict) : false;
      });
    }
    const descriptor = lookupDict(font.get(PDFName.of('FontDescriptor')));
    if (!descriptor) return false; // Standard-14-Schrift ohne Einbettung
    return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor.has(PDFName.of(k)));
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font')) {
      // CIDFonts werden über ihr Type0-Elternobjekt geprüft
      const st = obj.get(PDFName.of('Subtype'));
      if (st === PDFName.of('CIDFontType0') || st === PDFName.of('CIDFontType2')) continue;
      if (!embedded(obj)) return false;
    }
  }
  return true;
}

/**
 * Seiten der Nachweise hinten an das Rechnungs-PDF anhängen.
 * Metadaten, XMP, OutputIntent und eingebettete Rechnung (factur-x.xml) bleiben erhalten.
 */
export async function appendPdfs(base: Buffer, attachments: Uint8Array[]): Promise<Buffer> {
  if (!attachments.length) return base;
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  for (const a of attachments) {
    const src = await PDFDocument.load(a, { updateMetadata: false });
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) doc.addPage(p);
  }
  return Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
}

/**
 * Fotos (JPEG/PNG) zu einem PDF zusammenfassen – eine Seite je Bild, A4 im Hoch- bzw.
 * Querformat passend zum Bild, Bild mit Rand eingepasst. Für mehrseitige Belege (z. B. eine
 * lange Quittung in zwei Fotos), die als ein Beleg abgelegt werden.
 */
export async function imagesToPdf(images: { data: Uint8Array; mime: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer('Schottr');
  doc.setCreator('Schottr');
  const A4 = [595.28, 841.89];
  const margin = 20;
  for (const img of images) {
    const embedded = img.mime === 'image/png' ? await doc.embedPng(img.data) : await doc.embedJpg(img.data);
    const landscape = embedded.width > embedded.height;
    const [w, h] = landscape ? [A4[1], A4[0]] : A4;
    const scale = Math.min((w - 2 * margin) / embedded.width, (h - 2 * margin) / embedded.height, 1e9);
    const dw = embedded.width * scale;
    const dh = embedded.height * scale;
    const page = doc.addPage([w, h]);
    page.drawImage(embedded, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh });
  }
  return doc.save();
}
