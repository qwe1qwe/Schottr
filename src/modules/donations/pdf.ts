import PDFDocument from 'pdfkit';
import { FONTS } from '../../einvoice/pdf.ts';
import { formatDate } from '../../lib/dates.ts';
import { formatMoney } from '../../lib/money.ts';
import { amountInWords } from '../../lib/words.ts';
import { noticeText, periodText, purposeText, TEXT, type ReceiptData } from './receipt.ts';

const mm = (v: number) => v * 2.834645669;
const PAGE_W = mm(210);
const LEFT = mm(22);
const RIGHT = PAGE_W - mm(18);
const WIDTH = RIGHT - LEFT;
const BOTTOM = mm(282);

const INK = '#1d1d1b';
const MUTED = '#6b6a66';
const RULE = '#9d9b94';
const ACCENT = '#2b5d4f';

/**
 * Zuwendungsbestätigung als PDF im Aufbau des amtlichen Musters.
 * Die Bestätigung selbst passt auf eine A4-Seite; die Sammelbestätigung bekommt die Anlage
 * mit den einzelnen Zuwendungen auf eigenen Seiten.
 */
export function renderReceiptPdf(d: ReceiptData, logo?: { data: Buffer; mime: string } | null): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: mm(15), bottom: 0, left: LEFT, right: PAGE_W - RIGHT },
    bufferPages: true,
    font: FONTS.regular,
    lang: 'de-DE',
    displayTitle: true,
    info: {
      Title: `${TEXT.titles[d.kind]} ${d.number}`,
      Author: d.issuer.name,
      Creator: 'Schottr',
      Producer: 'Schottr (PDFKit)',
      CreationDate: new Date(`${d.issueDate}T12:00:00Z`),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('R', FONTS.regular);
  doc.registerFont('B', FONTS.bold);

  const text = (s: string, x: number, y: number, o: { w?: number; font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
    doc.font(o.font ?? 'R').fontSize(o.size ?? 9).fillColor(o.color ?? INK).text(s, x, y, { width: o.w ?? WIDTH, align: o.align, lineGap: 1.2 });
    return doc.y;
  };
  const height = (s: string, w: number, size = 9, font = 'R') => doc.font(font).fontSize(size).heightOfString(s, { width: w, lineGap: 1.2 });

  /** Feld mit kleiner Beschriftung oben und Inhalt darunter, umrandet */
  const box = (x: number, y: number, w: number, label: string, value: string, opts: { bold?: boolean; minH?: number } = {}) => {
    const pad = mm(1.8);
    const lh = height(label, w - 2 * pad, 7);
    const vh = height(value || ' ', w - 2 * pad, 9.5, opts.bold ? 'B' : 'R');
    const h = Math.max(opts.minH ?? 0, pad + lh + mm(1) + vh + pad);
    doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(RULE).stroke();
    text(label, x + pad, y + pad, { w: w - 2 * pad, size: 7, color: MUTED });
    text(value, x + pad, y + pad + lh + mm(1), { w: w - 2 * pad, size: 9.5, font: opts.bold ? 'B' : 'R' });
    return h;
  };

  /** Kästchen (angekreuzt oder leer) */
  const check = (x: number, y: number, on: boolean) => {
    const s = mm(3.2);
    doc.rect(x, y, s, s).lineWidth(0.6).strokeColor(INK).stroke();
    if (on) {
      doc.save().lineWidth(0.9).strokeColor(INK)
        .moveTo(x + 1.6, y + 1.6).lineTo(x + s - 1.6, y + s - 1.6)
        .moveTo(x + s - 1.6, y + 1.6).lineTo(x + 1.6, y + s - 1.6).stroke().restore();
    }
  };
  /** Absatz mit angekreuztem Kästchen davor */
  const checked = (y: number, s: string, size = 9) => {
    check(LEFT, y + 0.5, true);
    return text(s, LEFT + mm(6), y, { w: WIDTH - mm(6), size }) + mm(2.2);
  };

  /* ---------- Kopf: Aussteller ---------- */
  let y = mm(15);
  text(TEXT.issuerLabel, LEFT, y, { size: 7, color: MUTED });
  y = doc.y + 1;
  const issuerW = logo ? WIDTH - mm(55) : WIDTH;
  text(d.issuer.name, LEFT, y, { font: 'B', size: 11, w: issuerW });
  text(`${d.issuer.street}, ${d.issuer.zip} ${d.issuer.city}`, LEFT, doc.y, { size: 9, w: issuerW });
  y = doc.y;
  if (logo) {
    doc.image(logo.data, RIGHT - mm(50), mm(12), { fit: [mm(50), mm(18)], align: 'right' });
    y = Math.max(y, mm(31));
  }
  y += mm(4);

  /* ---------- Titel ---------- */
  text(TEXT.titles[d.kind], LEFT, y, { font: 'B', size: 13, color: ACCENT });
  y = text(TEXT.basis, LEFT, doc.y + 1, { size: 8.5 }) + mm(4);

  /* ---------- Zuwendender und Betrag ---------- */
  y += box(LEFT, y, WIDTH, TEXT.donor, d.donor.join(', ')) + mm(2);
  const words = amountInWords(d.total);
  const colA = mm(42);
  const colC = mm(48);
  const colB = WIDTH - colA - colC - mm(4);
  const whenLabel = d.kind === 'collective' ? TEXT.period : TEXT.date;
  const when = d.kind === 'collective' ? periodText(d.periodFrom!, d.periodTo!) : formatDate(d.date!);
  const rowH = Math.max(
    height(words, colB - mm(3.6), 9.5) + height(TEXT.letters, colB, 7) + mm(5),
    height(`${TEXT.amount[d.kind]} ${TEXT.digits}`, colA - mm(3.6), 7) + mm(10),
  );
  box(LEFT, y, colA, `${TEXT.amount[d.kind]} ${TEXT.digits}`, formatMoney(d.total), { bold: true, minH: rowH });
  box(LEFT + colA + mm(2), y, colB, TEXT.letters, words, { minH: rowH });
  box(RIGHT - colC, y, colC, whenLabel, when, { minH: rowH });
  y += rowH + mm(4);

  /* ---------- Sachzuwendung ---------- */
  if (d.kind === 'goods' && d.goods) {
    y += box(LEFT, y, WIDTH, TEXT.goodsDescription, d.goods.description) + mm(3);
    if (d.goods.origin) y = checked(y, TEXT.goodsOrigin[d.goods.origin]);
    if (d.goods.documents) y = checked(y, TEXT.goodsDocuments);
    y += mm(1.5);
  }

  /* ---------- Verzicht auf Erstattung von Aufwendungen ---------- */
  if (d.kind === 'single') {
    text(TEXT.waiver, LEFT, y, { w: WIDTH - mm(42) });
    const cx = RIGHT - mm(40);
    text('Ja', cx, y, { w: mm(8) });
    check(cx + mm(6), y + 0.5, !!d.waiver);
    text('Nein', cx + mm(16), y, { w: mm(10) });
    check(cx + mm(25), y + 0.5, !d.waiver);
    y += mm(8);
  } else if (d.kind === 'collective') {
    y = text(TEXT.waiverInAnnex, LEFT, y) + mm(3.5);
  }

  /* ---------- Steuerbegünstigung, Verwendung ---------- */
  y = checked(y, noticeText(d)) + mm(1.5);
  y = text(purposeText(d), LEFT, y) + mm(3.5);
  if (d.membershipNotDeductible && d.kind !== 'goods') {
    y = text(TEXT.membershipLabel, LEFT, y, { size: 8, color: MUTED }) + mm(1);
    y = checked(y, TEXT.membership) + mm(1);
  }
  if (d.kind === 'collective') y = text(TEXT.noOther, LEFT, y) + mm(3);

  /* ---------- Unterschrift ---------- */
  y = Math.max(y + mm(4), y);
  text(`${d.issuer.city}, ${formatDate(d.issueDate)}`, LEFT, y + mm(9));
  const lineY = y + mm(15);
  doc.moveTo(LEFT, lineY).lineTo(LEFT + mm(95), lineY).lineWidth(0.5).strokeColor(INK).stroke();
  text(TEXT.signature, LEFT, lineY + mm(1), { size: 7.5, color: MUTED, w: mm(95) });
  if (d.signer) text(d.signer, LEFT, doc.y + 1, { size: 8.5, w: mm(95) });
  y = doc.y + mm(5);

  /* ---------- Hinweis (unten auf der Seite) ---------- */
  const hint = [TEXT.hint1, TEXT.hint2];
  const hintH = height(TEXT.hintTitle, WIDTH, 7.5, 'B') + hint.reduce((a, s) => a + height(s, WIDTH, 7.5) + mm(1.5), 0);
  let hy = Math.max(y, BOTTOM - mm(6) - hintH);
  hy = text(TEXT.hintTitle, LEFT, hy, { size: 7.5, font: 'B' });
  for (const s of hint) hy = text(s, LEFT, hy, { size: 7.5 }) + mm(1.5);

  /* ---------- Anlage zur Sammelbestätigung ---------- */
  if (d.kind === 'collective' && d.items?.length) {
    const cols = [mm(30), mm(66), mm(48)];
    cols.push(WIDTH - cols.reduce((a, b) => a + b, 0));
    const pad = mm(1.5);
    const header = (start: number) => {
      let ay = text(TEXT.annexTitle, LEFT, start, { font: 'B', size: 12, color: ACCENT });
      ay = text(`${d.number} · ${d.donor[0] ?? ''} · ${periodText(d.periodFrom!, d.periodTo!)}`, LEFT, ay + 1, { size: 9, color: MUTED }) + mm(4);
      const hh = Math.max(...TEXT.annexCols.map((cName, i) => height(cName, cols[i] - 2 * pad, 8, 'B'))) + 2 * pad;
      let x = LEFT;
      TEXT.annexCols.forEach((cName, i) => {
        doc.rect(x, ay, cols[i], hh).lineWidth(0.5).strokeColor(RULE).stroke();
        text(cName, x + pad, ay + pad, { w: cols[i] - 2 * pad, size: 8, font: 'B', align: i === 3 ? 'right' : 'left' });
        x += cols[i];
      });
      return ay + hh;
    };
    doc.addPage();
    let ay = header(mm(18));
    const rowH = mm(6.5);
    const row = (cells: string[], bold = false) => {
      if (ay + rowH > BOTTOM) {
        doc.addPage();
        ay = header(mm(18));
      }
      let x = LEFT;
      cells.forEach((cell, i) => {
        doc.rect(x, ay, cols[i], rowH).lineWidth(0.5).strokeColor(RULE).stroke();
        text(cell, x + pad, ay + mm(1.6), { w: cols[i] - 2 * pad, size: 9, font: bold ? 'B' : 'R', align: i === 3 ? 'right' : 'left' });
        x += cols[i];
      });
      ay += rowH;
    };
    for (const it of d.items) {
      row([formatDate(it.date), it.kind === 'membership' ? 'Mitgliedsbeitrag' : 'Geldzuwendung', it.waiver ? 'ja' : 'nein', formatMoney(it.amount)]);
    }
    row([TEXT.annexTotal, '', '', formatMoney(d.total)], true);
  }

  /* ---------- Fußzeile: Nummer und Seite ---------- */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footer = `${d.number}${range.count > 1 ? ` · Seite ${i + 1} von ${range.count}` : ''}`;
    doc.font('R').fontSize(7).fillColor(MUTED).text(footer, LEFT, mm(288), { width: WIDTH, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
