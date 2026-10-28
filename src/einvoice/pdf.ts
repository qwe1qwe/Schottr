import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDate } from '../lib/dates.ts';
import { formatAmount, formatMoney, formatQuantity, formatRate } from '../lib/money.ts';
import { unitShort } from '../lib/units.ts';
import { formatIban } from '../lib/validate.ts';
import { INVOICE_TYPES, dueAmount, representativeLabel, type DocumentData } from './model.ts';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'IBMPlexSans-Regular.woff'),
  bold: path.join(FONT_DIR, 'IBMPlexSans-SemiBold.woff'),
  italic: path.join(FONT_DIR, 'IBMPlexSans-Italic.woff'),
};

const mm = (v: number) => v * 2.834645669;
const PAGE_W = mm(210);
const LEFT = mm(25);
export const LETTER_LEFT = LEFT;
const RIGHT = PAGE_W - mm(20);
const WIDTH = RIGHT - LEFT;
const FOOTER_TOP = mm(270);
const CONTENT_BOTTOM = FOOTER_TOP - mm(10);

const INK = '#1d1d1b';
const MUTED = '#6b6a66';
const RULE = '#cfcdc6';
const ACCENT = '#2b5d4f';

export interface PdfOptions {
  /** XML für ZUGFeRD einbetten → PDF/A-3b */
  zugferdXml?: string;
  /** Firmenlogo (PNG/JPEG) */
  logo?: { data: Buffer; mime: string } | null;
}

const xmlEsc = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function title(d: DocumentData): string {
  if (d.kind === 'quote') return 'Angebot';
  return INVOICE_TYPES[d.typeCode] ?? 'Rechnung';
}

/** ZUGFeRD/Factur-X XMP-Erweiterung (Pflicht für PDF/A-3 mit eingebetteter Rechnung). */
function facturXmp(): string {
  const prop = (name: string, desc: string) => `
              <rdf:li rdf:parseType="Resource">
                <pdfaProperty:name>${name}</pdfaProperty:name>
                <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                <pdfaProperty:category>external</pdfaProperty:category>
                <pdfaProperty:description>${desc}</pdfaProperty:description>
              </rdf:li>`;
  return `
        <rdf:Description xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#" rdf:about="">
          <fx:DocumentType>INVOICE</fx:DocumentType>
          <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
          <fx:Version>1.0</fx:Version>
          <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
        </rdf:Description>
        <rdf:Description xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#" rdf:about="">
          <pdfaExtension:schemas>
            <rdf:Bag>
              <rdf:li rdf:parseType="Resource">
                <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
                <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
                <pdfaSchema:prefix>fx</pdfaSchema:prefix>
                <pdfaSchema:property>
                  <rdf:Seq>${prop('DocumentFileName', 'name of the embedded XML invoice file')}${prop('DocumentType', 'INVOICE')}${prop('Version', 'The actual version of the Factur-X XML schema')}${prop('ConformanceLevel', 'The conformance level of the embedded Factur-X data')}
                  </rdf:Seq>
                </pdfaSchema:property>
              </rdf:li>
            </rdf:Bag>
          </pdfaExtension:schemas>
        </rdf:Description>`;
}

/* ======================================================================
 * Briefbogen (DIN 5008) – gemeinsam für Angebot, Rechnung und Mahnung
 * ==================================================================== */

export interface LetterParty {
  name: string;
  contactName: string;
  street: string;
  addressExtra: string;
  zip: string;
  city: string;
  country: string;
}

export interface LetterSeller extends LetterParty {
  phone: string;
  email: string;
  website: string;
  taxNumber: string;
  vatId: string;
  bankName: string;
  iban: string;
  bic: string;
  registerCourt: string;
  registerNumber: string;
  managingDirectors: string;
  orgType?: 'company' | 'association';
}

export interface LetterOptions {
  seller: LetterSeller;
  recipient: LetterParty;
  info: [string, string][];
  title: string;
  subtitle?: string;
  note?: string;
  issueDate: string;
  draft?: boolean;
  zugferdXml?: string;
  logo?: { data: Buffer; mime: string } | null;
}

export interface Letter {
  doc: PDFKit.PDFDocument;
  y: number;
  newPage(): number;
  /** Absätze mit automatischem Seitenumbruch ausgeben; liefert neues y */
  paragraphs(y: number, list: { text: string; font?: string; color?: string }[]): number;
  finish(): Promise<Buffer>;
}

export function startLetter(o: LetterOptions): Letter {
  const pdfa = !!o.zugferdXml;
  const s = o.seller;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: mm(20), bottom: 0, left: LEFT, right: PAGE_W - RIGHT },
    bufferPages: true,
    autoFirstPage: true,
    font: FONTS.regular,
    lang: 'de-DE',
    displayTitle: true,
    info: {
      // PDFKit schreibt diese Werte ungeschützt ins XMP – daher maskieren
      Title: xmlEsc(o.title),
      Author: xmlEsc(s.name),
      Subject: xmlEsc(o.subtitle || o.title),
      Creator: 'Schottr',
      Producer: 'Schottr (PDFKit)',
      CreationDate: new Date(`${o.issueDate}T12:00:00Z`),
    },
    ...(pdfa ? { pdfVersion: '1.7' as const, subset: 'PDF/A-3b' as const, tagged: false } : {}),
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('R', FONTS.regular);
  doc.registerFont('B', FONTS.bold);
  doc.registerFont('I', FONTS.italic);
  doc.font('R').fillColor(INK);

  if (pdfa) {
    doc.appendXML(facturXmp());
    doc.file(Buffer.from(o.zugferdXml!, 'utf8'), {
      name: 'factur-x.xml',
      type: 'text/xml',
      relationship: 'Alternative',
      description: 'Factur-X/ZUGFeRD Rechnung',
      creationDate: new Date(`${o.issueDate}T12:00:00Z`),
      modifiedDate: new Date(`${o.issueDate}T12:00:00Z`),
    } as any);
  }

  const header = () => {
    if (o.logo) {
      // Logo oben rechts (max. 60 × 22 mm), darunter die Kurzadresse
      doc.image(o.logo.data, RIGHT - mm(60), mm(10), { fit: [mm(60), mm(22)], align: 'right', valign: 'bottom' });
      doc.font('R').fontSize(8).fillColor(MUTED)
        .text([s.name, s.street, [s.zip, s.city].join(' ')].filter(Boolean).join(' · '), LEFT, mm(34), { width: WIDTH, align: 'right' });
    } else {
      doc.font('B').fontSize(15).fillColor(INK).text(s.name, LEFT, mm(16), { width: WIDTH, align: 'right' });
      doc.font('R').fontSize(8).fillColor(MUTED)
        .text([s.street, [s.zip, s.city].join(' ')].filter(Boolean).join(' · '), LEFT, doc.y + 1, { width: WIDTH, align: 'right' });
    }
    // Falz- und Lochmarken (DIN 5008)
    doc.save().lineWidth(0.4).strokeColor(RULE);
    for (const y of [mm(105), mm(210)]) doc.moveTo(mm(4), y).lineTo(mm(8), y).stroke();
    doc.moveTo(mm(4), mm(148.5)).lineTo(mm(10), mm(148.5)).stroke();
    doc.restore();
  };
  header();

  // Rücksendeangabe + Empfänger (Anschriftfeld DIN 5008 Form B)
  const senderLine = [s.name, s.street, [s.zip, s.city].join(' ')].filter(Boolean).join(' · ');
  doc.font('R').fontSize(7).fillColor(MUTED).text(senderLine, LEFT, mm(47), { width: mm(85), lineBreak: false, ellipsis: true });
  doc.moveTo(LEFT, mm(50.2)).lineTo(LEFT + mm(85), mm(50.2)).lineWidth(0.3).strokeColor(RULE).stroke();
  const r = o.recipient;
  const recipient = [
    r.name, r.contactName, r.street, r.addressExtra, [r.zip, r.city].filter(Boolean).join(' '),
    r.country && r.country !== 'DE' ? r.country : '',
  ].filter(Boolean);
  doc.font('R').fontSize(10).fillColor(INK).text(recipient.join('\n'), LEFT, mm(54), { width: mm(85), lineGap: 1.5 });

  // Infoblock
  const infoX = mm(125);
  let iy = mm(50);
  doc.fontSize(8.5);
  for (const [label, value] of o.info) {
    doc.font('R').fillColor(MUTED).text(label, infoX, iy, { width: mm(30) });
    doc.font('R').fillColor(INK).text(value, infoX + mm(31), iy, { width: RIGHT - infoX - mm(31) });
    iy = Math.max(doc.y + 1, iy + 12);
  }

  // Titel
  let y = Math.max(mm(100), iy + mm(6));
  doc.font('B').fontSize(16).fillColor(ACCENT).text(o.title, LEFT, y, { width: WIDTH });
  if (o.subtitle) doc.font('R').fontSize(10.5).fillColor(INK).text(o.subtitle, LEFT, doc.y + 2, { width: WIDTH });
  if (o.note) doc.font('R').fontSize(9.5).fillColor(MUTED).text(o.note, LEFT, doc.y + 2, { width: WIDTH });
  y = doc.y + mm(5);

  const newPage = () => {
    doc.addPage();
    header();
    return mm(40);
  };

  const paragraphs: Letter['paragraphs'] = (startY, list) => {
    let py = startY;
    for (const p of list) {
      doc.font(p.font ?? 'R').fontSize(9.5);
      const h = doc.heightOfString(p.text, { width: WIDTH, lineGap: 1.5 });
      if (py + h > CONTENT_BOTTOM) py = newPage();
      doc.fillColor(p.color ?? INK).text(p.text, LEFT, py, { width: WIDTH, lineGap: 1.5 });
      py = doc.y + mm(3);
    }
    return py;
  };

  const finish = () => {
    const footerCols = [
      [s.name, s.street, [s.zip, s.city].join(' '), s.managingDirectors ? `${representativeLabel(s, 'Geschäftsführung')}: ${s.managingDirectors}` : ''],
      [s.phone ? `Tel. ${s.phone}` : '', s.email, s.website, [s.registerCourt, s.registerNumber].filter(Boolean).join(' ')],
      [s.taxNumber ? `Steuernr. ${s.taxNumber}` : '', s.vatId ? `USt-IdNr. ${s.vatId}` : '', s.bankName, s.iban ? `IBAN ${formatIban(s.iban)}` : '', s.bic ? `BIC ${s.bic}` : ''],
    ].map((c) => c.filter(Boolean).join('\n'));
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.moveTo(LEFT, FOOTER_TOP).lineTo(RIGHT, FOOTER_TOP).lineWidth(0.3).strokeColor(RULE).stroke();
      const colW = WIDTH / 3;
      doc.font('R').fontSize(7).fillColor(MUTED);
      footerCols.forEach((text, ci) => doc.text(text, LEFT + ci * colW, FOOTER_TOP + 5, { width: colW - 6, lineGap: 0.5, lineBreak: true }));
      if (range.count > 1) {
        doc.text(`Seite ${i + 1} von ${range.count}`, LEFT, FOOTER_TOP - 12, { width: WIDTH, align: 'right', lineBreak: false });
      }
      if (o.draft) {
        doc.save().rotate(-35, { origin: [PAGE_W / 2, mm(150)] }).font('B').fontSize(90).fillColor('#e4e2dc')
          .opacity(0.6).text('ENTWURF', 0, mm(140), { width: PAGE_W, align: 'center', lineBreak: false }).restore();
      }
    }
    doc.end();
    return done;
  };

  return { doc, y, newPage, paragraphs, finish };
}

/** Prüft, ob PDFKit das Bild einbetten kann (z. B. keine interlaced PNGs). */
export function canEmbedImage(data: Buffer): boolean {
  try {
    const doc = new PDFDocument({ autoFirstPage: false });
    (doc as unknown as { openImage(src: Buffer): unknown }).openImage(data);
    return true;
  } catch {
    return false;
  }
}

/** Bankverbindung als Zahlungshinweis */
export function bankLine(s: LetterSeller, reference: string): string {
  return `Bankverbindung: ${s.bankName ? s.bankName + ', ' : ''}IBAN ${formatIban(s.iban)}${s.bic ? ', BIC ' + s.bic : ''} · Verwendungszweck: ${reference}`;
}

/** Summenblock (Standard: rechtsbündig ab 95 mm); liefert neues y */
export function sumBlock(letter: Letter, startY: number, rows: [string, string, boolean][], labelX = LEFT + mm(70)): number {
  const { doc } = letter;
  let y = startY;
  if (y + rows.length * 15 + 10 > CONTENT_BOTTOM) y = letter.newPage();
  y += 4;
  const labelW = RIGHT - labelX - mm(32);
  for (const [label, value, strong] of rows) {
    if (strong) {
      doc.moveTo(labelX, y - 2).lineTo(RIGHT, y - 2).lineWidth(0.6).strokeColor(INK).stroke();
      y += 3;
    }
    doc.font(strong ? 'B' : 'R').fontSize(strong ? 10.5 : 9.5).fillColor(INK);
    const h = doc.heightOfString(label, { width: labelW });
    doc.text(label, labelX, y, { width: labelW });
    doc.text(value, RIGHT - mm(30), y, { width: mm(30), align: 'right' });
    y += Math.max(strong ? 17 : 14, h + 3);
  }
  return y;
}

/* ======================================================================
 * Angebot / Rechnung
 * ==================================================================== */

export function renderPdf(d: DocumentData, opts: PdfOptions = {}): Promise<Buffer> {
  const s = d.seller;
  const b = d.buyer;

  const info: [string, string][] = [];
  if (d.kind === 'quote') {
    info.push(['Angebotsnr.', d.number], ['Datum', formatDate(d.issueDate)]);
    if (d.validUntil) info.push(['Gültig bis', formatDate(d.validUntil)]);
  } else {
    info.push([d.typeCode === '381' ? 'Storno-Nr.' : 'Rechnungsnr.', d.number], ['Rechnungsdatum', formatDate(d.issueDate)]);
    if (d.serviceDate) info.push(['Leistungsdatum', formatDate(d.serviceDate)]);
    if (d.serviceFrom && d.serviceTo) info.push(['Leistungszeitraum', `${formatDate(d.serviceFrom)} – ${formatDate(d.serviceTo)}`]);
    if (d.dueDate && d.typeCode !== '381') info.push(['Fällig am', formatDate(d.dueDate)]);
  }
  if (b.customerNumber) info.push(['Kundennr.', b.customerNumber]);
  if (d.orderReference) info.push(['Ihre Bestellung', d.orderReference]);
  if (b.leitwegId) info.push(['Leitweg-ID', b.leitwegId]);
  if (b.vatId) info.push(['Ihre USt-IdNr.', b.vatId]);
  if (s.contactName) info.push(['Ansprechpartner', s.contactName]);

  const letter = startLetter({
    seller: s,
    recipient: b,
    info,
    title: `${title(d)} ${d.number}`.trim(),
    subtitle: d.subject,
    note: d.precedingInvoice ? `Storno zur Rechnung ${d.precedingInvoice.number} vom ${formatDate(d.precedingInvoice.issueDate)}` : undefined,
    issueDate: d.issueDate,
    draft: d.draft,
    zugferdXml: opts.zugferdXml,
    logo: opts.logo,
  });
  const { doc } = letter;
  let y = letter.y;

  doc.font('R').fontSize(9.5).fillColor(INK);
  if (d.intro) {
    doc.text('Sehr geehrte Damen und Herren,', LEFT, y, { width: WIDTH });
    doc.moveDown(0.6).text(d.intro, { width: WIDTH, lineGap: 1.5 });
    y = doc.y + mm(5);
  }

  /* ---------- Positionstabelle ---------- */
  const showVat = d.taxMode === 'standard';
  const cols = {
    pos: { x: LEFT, w: mm(9) },
    title: { x: LEFT + mm(9), w: mm(showVat ? 76 : 88) },
    qty: { x: LEFT + mm(showVat ? 85 : 97), w: mm(22) },
    price: { x: LEFT + mm(showVat ? 107 : 119), w: mm(23) },
    vat: { x: LEFT + mm(130), w: mm(12) },
    total: { x: RIGHT - mm(23), w: mm(23) },
  };

  const tableHeader = (top: number) => {
    doc.font('B').fontSize(8).fillColor(MUTED);
    doc.text('Pos.', cols.pos.x, top, { width: cols.pos.w });
    doc.text('Bezeichnung', cols.title.x, top, { width: cols.title.w });
    doc.text('Menge', cols.qty.x, top, { width: cols.qty.w, align: 'right' });
    doc.text('Einzelpreis', cols.price.x, top, { width: cols.price.w, align: 'right' });
    if (showVat) doc.text('USt.', cols.vat.x, top, { width: cols.vat.w, align: 'right' });
    doc.text('Gesamt', cols.total.x, top, { width: cols.total.w, align: 'right' });
    const lineY = top + 12;
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).lineWidth(0.6).strokeColor(INK).stroke();
    return lineY + 5;
  };

  y = tableHeader(y);
  for (const it of d.items) {
    const sub = [it.articleNumber ? `Art.-Nr. ${it.articleNumber}` : '', it.description].filter(Boolean).join('\n');
    doc.font('B').fontSize(9.5);
    const hTitle = doc.heightOfString(it.title, { width: cols.title.w });
    doc.font('R').fontSize(8.5);
    const hDesc = sub ? doc.heightOfString(sub, { width: cols.title.w, lineGap: 1 }) + 2 : 0;
    const rowH = Math.max(hTitle + hDesc, 12) + 7;
    if (y + rowH > CONTENT_BOTTOM) y = tableHeader(letter.newPage());

    doc.font('R').fontSize(9.5).fillColor(INK);
    doc.text(String(it.position), cols.pos.x, y, { width: cols.pos.w });
    doc.font('B').text(it.title, cols.title.x, y, { width: cols.title.w });
    if (sub) {
      doc.font('R').fontSize(8.5).fillColor(MUTED).text(sub, cols.title.x, y + hTitle + 1, { width: cols.title.w, lineGap: 1 });
    }
    doc.font('R').fontSize(9.5).fillColor(INK);
    doc.text(`${formatQuantity(it.quantity)} ${unitShort(it.unit)}`, cols.qty.x, y, { width: cols.qty.w, align: 'right' });
    doc.text(formatAmount(it.unitPrice), cols.price.x, y, { width: cols.price.w, align: 'right' });
    if (showVat) doc.text(formatRate(it.vatRate), cols.vat.x, y, { width: cols.vat.w, align: 'right' });
    doc.text(formatAmount(it.lineTotal), cols.total.x, y, { width: cols.total.w, align: 'right' });
    y += rowH;
    doc.moveTo(LEFT, y - 4).lineTo(RIGHT, y - 4).lineWidth(0.3).strokeColor(RULE).stroke();
  }

  /* ---------- Summen ---------- */
  const sumRows: [string, string, boolean][] = [['Summe netto', formatMoney(d.net), false]];
  for (const t of d.taxes) {
    if (t.category === 'S') sumRows.push([`zzgl. ${formatRate(t.rate)} USt. auf ${formatMoney(t.basis)}`, formatMoney(t.tax), false]);
  }
  const prepayments = d.prepayments ?? [];
  sumRows.push([
    d.kind === 'quote' ? 'Angebotssumme' : d.typeCode === '381' ? 'Gutschriftsbetrag' : prepayments.length ? 'Gesamtbetrag der Leistung' : 'Rechnungsbetrag',
    formatMoney(d.gross), true,
  ]);
  // § 14 Abs. 5 UStG: vereinnahmte Teilentgelte und die darauf entfallende Steuer ausweisen
  for (const p of prepayments) {
    sumRows.push([`abzgl. ${p.number} vom ${formatDate(p.issueDate)}\n(netto ${formatMoney(p.net)}, USt. ${formatMoney(p.tax)})`, formatMoney(-p.gross), false]);
  }
  if (prepayments.length) sumRows.push(['Noch zu zahlen', formatMoney(dueAmount(d)), true]);
  y = sumBlock(letter, y, sumRows);

  /* ---------- Hinweise ---------- */
  const paragraphs: { text: string; font?: string; color?: string }[] = [];
  if (d.exemptionReason) paragraphs.push({ text: d.exemptionReason, font: 'B' });
  if (d.kind === 'invoice') paragraphs.push({ text: d.paymentTerms });
  if (d.kind === 'quote' && d.validUntil) paragraphs.push({ text: `Dieses Angebot ist gültig bis ${formatDate(d.validUntil)}.` });
  if (d.proofs?.length) paragraphs.push({ text: `Anlagen: ${d.proofs.map((p) => p.name).join(', ')}`, color: MUTED });
  if (d.outro) paragraphs.push({ text: d.outro });
  if (d.intro || d.outro) paragraphs.push({ text: 'Mit freundlichen Grüßen\n' + (s.contactName || s.name) });
  letter.paragraphs(y + mm(4), paragraphs);

  return letter.finish();
}
