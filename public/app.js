// Schottr – kleine Helfer ohne Framework.
(() => {
  'use strict';

  // Formulare mit Rückfrage
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form instanceof HTMLFormElement && form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
      e.preventDefault();
    }
  });

  // Auswahlfelder, die sofort absenden
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el instanceof HTMLElement && el.hasAttribute('data-autosubmit')) el.closest('form')?.requestSubmit();
  });

  // Ganze Tabellenzeile klickbar
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element) || target.closest('a, button, input, select, textarea, form')) return;
    const row = target.closest('tr[data-href]');
    if (row) window.location.href = row.getAttribute('data-href');
  });

  /* ---------- Beleg-Formular ---------- */
  const form = document.querySelector('[data-doc-form]');
  if (!form) return;

  const tbody = form.querySelector('[data-items] tbody');
  const template = form.querySelector('[data-item-template]');
  const taxMode = form.querySelector('[data-tax-mode]');
  const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const amount = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** "1.234,5" oder "1234.5" -> Zahl (ganzzahlig skaliert, um Rundungsfehler zu vermeiden) */
  const parse = (value, decimals) => {
    let s = String(value || '').trim().replace(/\s|€|%/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 10 ** decimals) : NaN;
  };
  const roundDiv = (a, b) => Math.sign(a) * Math.round(Math.abs(a) / b);

  function recalc() {
    const standard = !taxMode || taxMode.value === 'standard';
    form.classList.toggle('no-vat', !standard);
    const groups = new Map();
    let net = 0;
    for (const row of tbody.querySelectorAll('tr.item')) {
      const qty = parse(row.querySelector('[name="item_quantity[]"]').value || '1', 3);
      const price = parse(row.querySelector('[name="item_price[]"]').value || '0', 2);
      const rate = standard ? Number(row.querySelector('[name="item_vat[]"]').value) : 0;
      const cell = row.querySelector('.line-total');
      if (Number.isNaN(qty) || Number.isNaN(price)) {
        cell.textContent = '?';
        continue;
      }
      const total = roundDiv(qty * price, 1000);
      cell.textContent = amount.format(total / 100);
      net += total;
      groups.set(rate, (groups.get(rate) || 0) + total);
    }
    let tax = 0;
    for (const [rate, basis] of groups) tax += roundDiv(basis * rate, 10000);
    form.querySelector('[data-net]').textContent = eur.format(net / 100);
    form.querySelector('[data-tax]').textContent = eur.format(tax / 100);
    form.querySelector('[data-gross]').textContent = eur.format((net + tax) / 100);
    const exempt = form.querySelector('[data-exempt]');
    if (exempt) exempt.hidden = taxMode?.value !== 'exempt';
  }

  const autogrow = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };

  function addRow(focus = true) {
    const row = template.content.firstElementChild.cloneNode(true);
    tbody.appendChild(row);
    if (focus) row.querySelector('input[name="item_title[]"]').focus();
    recalc();
    return row;
  }

  // Artikel aus dem Artikelstamm einfügen (optional – freie Positionen bleiben möglich)
  const articleSearch = form.querySelector('[data-article-search]');
  if (articleSearch) {
    let articles = [];
    try {
      articles = JSON.parse(document.getElementById('article-data').textContent || '[]');
    } catch {
      articles = [];
    }
    const isEmpty = (row) =>
      !row.querySelector('[name="item_title[]"]').value.trim() && !row.querySelector('[name="item_price[]"]').value.trim();
    let inserting = false;
    const insert = () => {
      const a = articles.find((x) => x.label === articleSearch.value);
      if (!a || inserting) return;
      inserting = true;
      articleSearch.value = '';
      const last = tbody.querySelector('tr.item:last-child');
      const row = last && isEmpty(last) ? last : addRow(false);
      row.querySelector('[name="item_article[]"]').value = a.number || '';
      const tag = row.querySelector('.art-no');
      tag.hidden = !a.number;
      tag.querySelector('span').textContent = a.number || '';
      row.querySelector('[name="item_title[]"]').value = a.title;
      const desc = row.querySelector('[name="item_description[]"]');
      desc.value = a.description || '';
      autogrow(desc);
      row.querySelector('[name="item_unit[]"]').value = a.unit;
      row.querySelector('[name="item_price[]"]').value = a.price;
      row.querySelector('[name="item_vat[]"]').value = String(a.vat);
      recalc();
      const qty = row.querySelector('[name="item_quantity[]"]');
      qty.focus();
      qty.select();
      inserting = false;
    };
    // Auswahl aus der Vorschlagsliste löst „input“ aus, Tippen + Verlassen „change“
    articleSearch.addEventListener('input', insert);
    articleSearch.addEventListener('change', insert);
    articleSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        insert();
      }
    });
  }

  form.querySelector('[data-add-item]').addEventListener('click', () => addRow());

  tbody.addEventListener('click', (e) => {
    // Artikelbezug einer Position lösen (Werte bleiben als Freitext erhalten)
    const tag = e.target instanceof Element && e.target.closest('.art-no');
    if (tag) {
      tag.hidden = true;
      tag.closest('tr').querySelector('[name="item_article[]"]').value = '';
      return;
    }
    const btn = e.target instanceof Element && e.target.closest('.remove');
    if (!btn) return;
    btn.closest('tr').remove();
    if (!tbody.querySelector('tr.item')) addRow(false);
    recalc();
  });

  form.addEventListener('input', (e) => {
    if (e.target instanceof HTMLTextAreaElement) autogrow(e.target);
    recalc();
  });
  form.addEventListener('change', recalc);
  tbody.querySelectorAll('textarea').forEach(autogrow);

  // Enter in der letzten Zeile fügt eine neue Position hinzu statt abzusenden
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    const row = e.target.closest('tr');
    if (row === tbody.lastElementChild) addRow();
    else row.nextElementSibling?.querySelector('input')?.focus();
  });

  // Leistungsdatum oder -zeitraum
  const service = form.querySelector('[data-service]');
  if (service) {
    const sync = () => {
      const mode = service.querySelector('input[name="service_mode"]:checked')?.value || 'date';
      service.querySelectorAll('[data-mode]').forEach((el) => (el.hidden = el.dataset.mode !== mode));
    };
    service.addEventListener('change', sync);
    sync();
  }

  // Leitweg-ID des Kunden als Käuferreferenz vorschlagen
  const contact = form.querySelector('select[name="contact_id"]');
  const buyerRef = form.querySelector('[data-buyer-ref]');
  if (contact && buyerRef) {
    contact.addEventListener('change', () => {
      const leitweg = contact.selectedOptions[0]?.dataset.leitweg || '';
      if (!buyerRef.value || buyerRef.dataset.auto === '1') {
        buyerRef.value = leitweg;
        buyerRef.dataset.auto = '1';
      }
    });
  }

  recalc();
})();
