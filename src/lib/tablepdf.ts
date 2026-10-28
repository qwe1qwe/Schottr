import PDFDocument from 'pdfkit';
import { FONTS } from '../einvoice/pdf.ts';

/**
 * Schlichte Tabellen-PDFs (A4) für Auswertungen: Titel, Untertitel und beliebig viele
 * Abschnitte mit Tabelle. Spalten mit `right: true` werden rechtsbündig gesetzt;
 * Zeilen mit `bold` (z. B. Summen) fett. Seitenumbruch samt wiederholtem Tabellenkopf.
 */
export interface TableSection {
  heading?: string;
  text?: string;
  columns: { label: string; width: number; right?: boolean }[];
  rows: { cells: string[]; bold?: boolean; muted?: boolean }[];
}

const mm = (v: number) => v * 2.834645669;
const PAGE_W = mm(210);
const LEFT = mm(18);
const RIGHT = PAGE_W - mm(15);
const WIDTH = RIGHT - LEFT;
const BOTTOM = mm(280);
const INK = '#1d1d1b';
const MUTED = '#6b6a66';
const RULE = '#cfcdc6';
const ACCENT = '#2b5d4f';

export function renderTablePdf(opts: { title: string; subtitle?: string; author: string; footer: string; sections: TableSection[]; landscape?: boolean }): Promise<Buffer> {
  const landscape = !!opts.landscape;
  const pageW = landscape ? mm(297) : PAGE_W;
  const right = pageW - mm(15);
  const width = right - LEFT;
  const bottom = landscape ? mm(193) : BOTTOM;
  const doc = new PDFDocument({
    size: 'A4', layout: landscape ? 'landscape' : 'portrait', margins: { top: mm(15), bottom: 0, left: LEFT, right: pageW - right },
    bufferPages: true, font: FONTS.regular, lang: 'de-DE', displayTitle: true,
    info: { Title: opts.title, Author: opts.author, Creator: 'Schottr', Producer: 'Schottr (PDFKit)' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('R', FONTS.regular);
  doc.registerFont('B', FONTS.bold);

  let y = mm(15);
  doc.font('B').fontSize(15).fillColor(ACCENT).text(opts.title, LEFT, y, { width });
  if (opts.subtitle) doc.font('R').fontSize(9.5).fillColor(MUTED).text(opts.subtitle, LEFT, doc.y + 2, { width });
  y = doc.y + mm(6);

  const pad = mm(1.4);
  for (const s of opts.sections) {
    const total = s.columns.reduce((a, c) => a + c.width, 0);
    const cols = s.columns.map((c) => ({ ...c, w: (c.width / total) * width }));
    const rowHeight = (cells: string[], font: string, size: number) =>
      Math.max(...cells.map((cell, i) => doc.font(font).fontSize(size).heightOfString(cell || ' ', { width: cols[i].w - 2 * pad }))) + 2 * pad;
    const header = () => {
      const h = rowHeight(cols.map((c) => c.label), 'B', 7.5);
      let x = LEFT;
      doc.rect(LEFT, y, width, h).fillColor('#f1efe9').fill();
      for (const c of cols) {
        doc.font('B').fontSize(7.5).fillColor(INK).text(c.label, x + pad, y + pad, { width: c.w - 2 * pad, align: c.right ? 'right' : 'left' });
        x += c.w;
      }
      y += h;
    };
    const need = (h: number) => {
      if (y + h > bottom) {
        doc.addPage();
        y = mm(15);
        return true;
      }
      return false;
    };
    if (s.heading) {
      need(mm(20));
      doc.font('B').fontSize(11).fillColor(INK).text(s.heading, LEFT, y, { width });
      y = doc.y + mm(1.5);
    }
    if (s.text) {
      doc.font('R').fontSize(8.5).fillColor(MUTED).text(s.text, LEFT, y, { width });
      y = doc.y + mm(2);
    }
    header();
    for (const r of s.rows) {
      const font = r.bold ? 'B' : 'R';
      const h = rowHeight(r.cells, font, 8.5);
      if (need(h)) header();
      let x = LEFT;
      r.cells.forEach((cell, i) => {
        doc.font(font).fontSize(8.5).fillColor(r.muted ? MUTED : INK).text(cell, x + pad, y + pad, { width: cols[i].w - 2 * pad, align: cols[i].right ? 'right' : 'left' });
        x += cols[i].w;
      });
      y += h;
      doc.moveTo(LEFT, y).lineTo(right, y).lineWidth(0.3).strokeColor(RULE).stroke();
    }
    y += mm(7);
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('R').fontSize(7).fillColor(MUTED)
      .text(`${opts.footer} · Seite ${i + 1} von ${range.count}`, LEFT, landscape ? mm(200) : mm(288), { width, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
