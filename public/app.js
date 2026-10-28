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

  // Bestätigungscodes müssen abgetippt werden – Einfügen unterbinden
  for (const type of ['paste', 'drop']) {
    document.addEventListener(type, (e) => {
      if (e.target instanceof HTMLElement && e.target.hasAttribute('data-no-paste')) e.preventDefault();
    });
  }

  /* ---------- Menü am Handy ---------- */
  const menuToggle = document.querySelector('[data-menu-toggle]');
  if (menuToggle) {
    const setMenu = (open) => {
      document.body.classList.toggle('menu-open', open);
      menuToggle.setAttribute('aria-expanded', String(open));
      menuToggle.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
    };
    menuToggle.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('menu-open')) {
        setMenu(false);
        menuToggle.focus();
      }
    });
    // Beim Wechsel auf die breite Ansicht nicht im geöffneten Zustand hängen bleiben
    window.matchMedia('(min-width: 861px)').addEventListener('change', (m) => m.matches && setMenu(false));
    // Zurück-Navigation aus dem Cache (bfcache) mit geschlossenem Menü
    window.addEventListener('pageshow', () => setMenu(false));
  }

  // Aktiven Reiter in waagerecht scrollbaren Reiterleisten sichtbar machen
  document.querySelectorAll('.tabs').forEach((tabs) => {
    const active = tabs.querySelector('a.active');
    if (active && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = active.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2;
  });

  /* ---------- Tabellen am Handy als Karten ----------
   * Jede Zelle bekommt die Spaltenüberschrift als data-label; das CSS zeigt sie in der
   * schmalen Ansicht vor dem Wert an. Die erste Zelle (oder .stack-title) wird zur Kopfzeile. */
  document.querySelectorAll('table.table:not(.items)').forEach((table) => {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    table.classList.add('stack-mobile');
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = [...tr.children];
      cells.forEach((td, i) => td.setAttribute('data-label', heads[i] ?? ''));
      if (!tr.querySelector('.stack-title') && cells[0]) cells[0].classList.add('stack-title');
    });
  });

  /* ---------- Umsatzdiagramm: Wert des gewählten Monats anzeigen ---------- */
  document.querySelectorAll('[data-chart]').forEach((chart) => {
    const readout = chart.querySelector('[data-chart-readout]');
    const initial = readout?.textContent ?? '';
    const bars = chart.querySelectorAll('[data-bar]');
    const show = (bar) => {
      bars.forEach((b) => b.classList.toggle('selected', b === bar));
      if (readout) readout.textContent = bar ? bar.getAttribute('data-bar') : initial;
    };
    // Touch: erstes Antippen zeigt nur den Wert, zweites öffnet die Rechnungen des Monats.
    // (Beim Antippen feuern Browser zusätzlich mouseenter/focus – die zählen daher nicht als „gewählt“.)
    let touch = false;
    let armed = null;
    chart.addEventListener('pointerdown', (e) => (touch = e.pointerType !== 'mouse'));
    bars.forEach((bar) => {
      bar.addEventListener('mouseenter', () => !touch && show(bar));
      bar.addEventListener('focus', () => !touch && show(bar));
      bar.addEventListener('click', (e) => {
        if (touch && armed !== bar) {
          e.preventDefault();
          armed = bar;
          show(bar);
        }
      });
    });
    chart.addEventListener('mouseleave', () => show(null));
  });

  /* ---------- Ringdiagramm: Segment und Legendenzeile gemeinsam hervorheben ---------- */
  document.querySelectorAll('[data-pie]').forEach((pie) => {
    const items = pie.querySelectorAll('[data-slice]');
    const highlight = (id) => {
      pie.classList.toggle('has-active', id !== null);
      items.forEach((el) => el.classList.toggle('active', el.getAttribute('data-slice') === id));
    };
    items.forEach((el) => {
      const id = el.getAttribute('data-slice');
      el.addEventListener('mouseenter', () => highlight(id));
      el.addEventListener('focusin', () => highlight(id));
      el.addEventListener('mouseleave', () => highlight(null));
      el.addEventListener('focusout', () => highlight(null));
    });
  });

  /* ---------- Bereiche nur bei angehaktem Kontrollkästchen zeigen (data-show-if="<name>") ---------- */
  document.querySelectorAll('[data-show-if]').forEach((el) => {
    const box = el.closest('form')?.querySelector(`input[type="checkbox"][name="${el.dataset.showIf}"]`);
    if (!box) return;
    const sync = () => (el.hidden = !box.checked);
    box.addEventListener('change', sync);
    sync();
  });

  /* ---------- Zuwendung: Felder je Art (Geld, Mitgliedsbeitrag, Sachzuwendung) ---------- */
  document.querySelectorAll('[data-donation-form]').forEach((form) => {
    const sync = () => {
      const kind = form.querySelector('input[name="kind"]:checked')?.value ?? 'money';
      form.querySelectorAll('[data-kind-show]').forEach((el) => (el.hidden = !el.dataset.kindShow.split(' ').includes(kind)));
    };
    form.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', sync));
    sync();
  });

  /* ---------- Kacheln mit Umschalter (z. B. Lieferanten / Verbindlichkeiten) ---------- */
  document.querySelectorAll('[data-tabs]').forEach((box, n) => {
    const key = `schottr:tab:${location.pathname}:${n}`;
    const buttons = box.querySelectorAll('[data-tab]');
    const select = (name, remember) => {
      buttons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
      box.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
      if (remember) {
        try {
          localStorage.setItem(key, name);
        } catch {
          /* ohne Speicher */
        }
      }
    };
    box.classList.add('js-tabs');
    let start = buttons[0]?.dataset.tab;
    try {
      const saved = localStorage.getItem(key);
      if (saved && box.querySelector(`[data-panel="${saved}"]`)) start = saved;
    } catch {
      /* ohne Speicher */
    }
    buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.tab, true)));
    if (start) select(start, false);
  });

  // Ganze Tabellenzeile klickbar
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element) || target.closest('a, button, input, select, textarea, form')) return;
    const row = target.closest('tr[data-href]');
    if (row) window.location.href = row.getAttribute('data-href');
  });

  /* ---------- Eingaben nach Fehlern erhalten ----------
   * Beim Absenden werden die Werte (ohne Passwörter/Dateien) im sessionStorage dieses Tabs
   * gemerkt. Zeigt die Folgeseite eine Fehlermeldung und dasselbe Formular, werden sie
   * wieder eingesetzt – inkl. aller Positionszeilen. Ohne Fehler wird nichts übernommen. */
  const STORE = 'schottr:last-form';
  const SKIP = new Set(['password', 'file', 'submit', 'button', 'reset']);

  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (e.defaultPrevented || !(f instanceof HTMLFormElement) || f.method.toLowerCase() !== 'post') return;
    const fields = [];
    for (const el of f.elements) {
      if (!el.name || el.name === '_csrf' || SKIP.has(el.type) || el.disabled || el.hasAttribute('data-no-paste')) continue;
      if (el.type === 'checkbox' || el.type === 'radio') fields.push([el.name, el.value, el.checked]);
      else fields.push([el.name, el.value]);
    }
    try {
      sessionStorage.setItem(STORE, JSON.stringify({ action: f.getAttribute('action'), fields, t: Date.now() }));
    } catch {
      /* privater Modus o. Ä. – dann eben ohne */
    }
  });

  (function restoreAfterError() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      sessionStorage.removeItem(STORE);
    } catch {
      return;
    }
    if (!saved || Date.now() - saved.t > 5 * 60_000 || !document.querySelector('.flash-error')) return;
    const target = [...document.forms].find((f) => f.getAttribute('action') === saved.action);
    if (!target) return;

    // Positionszeilen in passender Anzahl anlegen
    const tbody = target.querySelector('[data-items] tbody');
    const tpl = target.querySelector('[data-item-template]');
    if (tbody && tpl) {
      const rows = saved.fields.filter(([n]) => n === 'item_title[]').length;
      tbody.replaceChildren();
      for (let i = 0; i < Math.max(rows, 1); i++) tbody.appendChild(tpl.content.firstElementChild.cloneNode(true));
    }

    // Steuerzeilen der Eingangsrechnung ebenso
    const taxBody = target.querySelector('[data-tax-rows] tbody');
    const taxTpl = target.querySelector('[data-tax-template]');
    if (taxBody && taxTpl) {
      const rows = saved.fields.filter(([n]) => n === 'tax_rate[]').length;
      taxBody.replaceChildren();
      for (let i = 0; i < Math.max(rows, 1); i++) taxBody.appendChild(taxTpl.content.firstElementChild.cloneNode(true));
    }

    const seen = {};
    for (const [name, value, checked] of saved.fields) {
      const els = [...target.elements].filter((el) => el.name === name);
      if (!els.length) continue;
      if (checked !== undefined) {
        const el = els.find((x) => x.value === value);
        if (el) el.checked = checked;
        continue;
      }
      const i = (seen[name] = (seen[name] ?? -1) + 1);
      if (els[i]) els[i].value = value;
    }
    // Artikelnummer-Kennzeichen der Positionen nachziehen
    target.querySelectorAll('tr.item').forEach((row) => {
      const art = row.querySelector('[name="item_article[]"]');
      const tag = row.querySelector('.art-no');
      if (art && tag) {
        tag.hidden = !art.value;
        tag.querySelector('span').textContent = art.value;
      }
    });
  })();

  /* ---------- Eingangsrechnungen: Upload ---------- */
  document.querySelectorAll('[data-upload]').forEach((form) => {
    const input = form.querySelector('[data-upload-input]');
    const list = form.querySelector('[data-upload-files]');
    const zone = form.querySelector('.drop-zone');
    const show = () => {
      const names = [...(input.files || [])].map((f) => f.name);
      list.hidden = !names.length;
      list.textContent = names.length ? `${names.length} Datei(en): ${names.join(', ')}` : '';
    };
    input.addEventListener('change', show);
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('dragging')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) {
        input.files = e.dataTransfer.files;
        show();
      }
    });
  });

  /* ---------- Eingangsrechnungen: Erfassung ---------- */
  const pform = document.querySelector('[data-purchase-form]');
  if (pform) {
    const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
    const amt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
    const cents = (v) => {
      let s = String(v || '').trim().replace(/\s|€/g, '');
      if (!s) return null;
      if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
      const n = Number(s);
      return Number.isFinite(n) ? Math.round(n * 100) : NaN;
    };
    const rnd = (a, b) => Math.sign(a) * Math.round(Math.abs(a) / b);
    const fmt = (c) => amt.format(c / 100);

    // Neuer Lieferant nur, wenn keiner gewählt ist; Kostenart des Lieferanten vorschlagen
    const supplier = pform.querySelector('[data-supplier]');
    const newSupplier = pform.querySelector('[data-new-supplier]');
    const category = pform.querySelector('[data-category]');
    if (supplier && newSupplier) {
      const sync = (fromUser) => {
        newSupplier.hidden = !!supplier.value;
        const cat = supplier.selectedOptions[0]?.dataset.category;
        if (fromUser && cat && category) category.value = cat;
      };
      supplier.addEventListener('change', () => sync(true));
      sync(false);
    }

    const rowsBody = pform.querySelector('[data-tax-rows] tbody');
    const tpl = pform.querySelector('[data-tax-template]');
    if (rowsBody && tpl) {
      // Welches Feld zuletzt von Hand geändert wurde, bestimmt die Rechenrichtung
      const recalcRow = (row, source) => {
        const rate = Number(row.querySelector('[name="tax_rate[]"]').value);
        const net = row.querySelector('[name="tax_net[]"]');
        const tax = row.querySelector('[name="tax_tax[]"]');
        const gross = row.querySelector('[name="tax_gross[]"]');
        const n = cents(net.value);
        const t = cents(tax.value);
        const g = cents(gross.value);
        if ([n, t, g].some(Number.isNaN)) return;
        if (source === 'gross' && g !== null) {
          const tt = g - rnd(g * 10000, 10000 + rate);
          tax.value = fmt(tt);
          net.value = fmt(g - tt);
        } else if (source === 'tax' && n !== null && t !== null) {
          gross.value = fmt(n + t);
        } else if (n !== null && (source === 'net' || source === 'rate')) {
          const tt = rnd(n * rate, 10000);
          tax.value = fmt(tt);
          gross.value = fmt(n + tt);
        } else if (source === 'rate' && g !== null) {
          recalcRow(row, 'gross');
        }
      };
      const totals = () => {
        let n = 0;
        let t = 0;
        rowsBody.querySelectorAll('tr.tax-row').forEach((row) => {
          n += cents(row.querySelector('[name="tax_net[]"]').value) || 0;
          t += cents(row.querySelector('[name="tax_tax[]"]').value) || 0;
        });
        pform.querySelector('[data-sum-net]').textContent = eurFmt.format(n / 100);
        pform.querySelector('[data-sum-tax]').textContent = eurFmt.format(t / 100);
        pform.querySelector('[data-sum-gross]').textContent = eurFmt.format((n + t) / 100);
      };
      rowsBody.addEventListener('input', (e) => {
        const name = e.target.name || '';
        const src = name.includes('gross') ? 'gross' : name.includes('tax_tax') ? 'tax' : name.includes('tax_net') ? 'net' : '';
        if (src) recalcRow(e.target.closest('tr'), src);
        totals();
      });
      rowsBody.addEventListener('change', (e) => {
        if (e.target.name === 'tax_rate[]') recalcRow(e.target.closest('tr'), 'rate');
        totals();
      });
      rowsBody.addEventListener('click', (e) => {
        const btn = e.target instanceof Element && e.target.closest('.remove');
        if (!btn) return;
        btn.closest('tr').remove();
        if (!rowsBody.querySelector('tr.tax-row')) rowsBody.appendChild(tpl.content.firstElementChild.cloneNode(true));
        totals();
      });
      pform.querySelector('[data-add-tax]')?.addEventListener('click', () => {
        const row = tpl.content.firstElementChild.cloneNode(true);
        const used = [...rowsBody.querySelectorAll('[name="tax_rate[]"]')].map((s) => s.value);
        const free = ['1900', '700', '0'].find((r) => !used.includes(r));
        if (free) row.querySelector('[name="tax_rate[]"]').value = free;
        rowsBody.appendChild(row);
        row.querySelector('[name="tax_gross[]"]').focus();
        totals();
      });
      totals();
    }
  }

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
    const msg = form.querySelector('[data-article-msg]');
    const isEmpty = (row) =>
      !row.querySelector('[name="item_title[]"]').value.trim() && !row.querySelector('[name="item_price[]"]').value.trim();

    /** exakter Treffer (Auswahl aus der Vorschlagsliste) oder – wenn erlaubt – erster Treffer im Text */
    const find = (query, fuzzy) => {
      const q = query.trim().toLowerCase();
      if (!q) return null;
      const exact = articles.find((a) => a.label.toLowerCase() === q || (a.number && a.number.toLowerCase() === q));
      if (exact || !fuzzy) return exact || null;
      return articles.find((a) => a.label.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q)) || null;
    };

    let inserting = false;
    const insert = (fuzzy) => {
      if (inserting) return;
      const a = find(articleSearch.value, fuzzy);
      if (msg) msg.hidden = !!a || !fuzzy || !articleSearch.value.trim();
      if (!a) return;
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
    // Klick auf einen Vorschlag → sofort einfügen; Tippen allein fügt nichts ein
    articleSearch.addEventListener('input', (e) => {
      if (msg) msg.hidden = true;
      if (!e.inputType || e.inputType === 'insertReplacementText') insert(false);
    });
    articleSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        insert(true);
      }
    });
    form.querySelector('[data-article-insert]')?.addEventListener('click', () => insert(true));
  }

  form.querySelector('[data-add-item]')?.addEventListener('click', () => addRow());

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

  // Teil-/Schlussrechnungen: abzuziehende Teilrechnungen nur bei 876/877 und nur des gewählten Kunden zeigen
  const typeSelect = form.querySelector('[data-type-code]');
  const prepaySection = form.querySelector('[data-prepayments]');
  if (prepaySection) {
    const syncPrepayments = () => {
      const isFinal = typeSelect && ['876', '877'].includes(typeSelect.value);
      prepaySection.hidden = !isFinal;
      const contactId = contact ? contact.value : '';
      let visible = 0;
      prepaySection.querySelectorAll('li[data-contact]').forEach((li) => {
        const show = li.dataset.contact === contactId;
        li.hidden = !show;
        const box = li.querySelector('input[type="checkbox"]');
        if (!show || !isFinal) box.checked = false;
        if (show) visible++;
      });
      const emptyNote = prepaySection.querySelector('[data-prepayments-empty]');
      if (emptyNote) emptyNote.hidden = visible > 0;
    };
    typeSelect?.addEventListener('change', syncPrepayments);
    contact?.addEventListener('change', syncPrepayments);
    syncPrepayments();
  }

  recalc();
})();
