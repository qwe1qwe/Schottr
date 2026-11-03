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

  /* ---------- Nachträgliche Buchung vor einer Kassenzählung: Hinweis vorher ---------- */
  // Formulare mit data-count-check: Konto-Feld(er) in data-count-accounts (Standard account_id),
  // Datumsfeld in data-count-date (Standard entry_date), bisheriger Stand beim Bearbeiten in
  // data-count-orig („Konto:Datum“). Liegt eine Zählung dieser Kasse am oder nach dem Tag,
  // wird vor dem Speichern gefragt – die Zählungen werden danach neu berechnet.
  let countDates = null;
  const countForms = [...document.querySelectorAll('form[data-count-check]')];
  const hasAccountField = (f) => (f.dataset.countAccounts || 'account_id').split(',').some((n) => f.elements.namedItem(n));
  if (countForms.some(hasAccountField)) {
    fetch('/cashbook/counts.json', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => { countDates = d; })
      .catch(() => { countDates = {}; });
  }
  const deDate = (d) => d.split('-').reverse().join('.');
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-count-check') || !countDates || e.defaultPrevented) return;
    const dateField = form.elements.namedItem(form.dataset.countDate || 'entry_date');
    const date = dateField && 'value' in dateField ? dateField.value : '';
    const checks = [];
    if (date) {
      for (const n of (form.dataset.countAccounts || 'account_id').split(',')) {
        const el = form.elements.namedItem(n);
        if (el && 'value' in el && el.value) checks.push([el.value, date]);
      }
    }
    const orig = (form.dataset.countOrig || '').split(':');
    if (orig[0] && orig[1]) checks.push([orig[0], orig[1]]);
    // je Kasse der früheste betroffene Tag
    const from = {};
    for (const [acc, d] of checks) if (!from[acc] || d < from[acc]) from[acc] = d;
    const lines = [];
    for (const [acc, d] of Object.entries(from)) {
      const info = countDates[acc];
      const later = info ? info.dates.filter((x) => x >= d) : [];
      if (!later.length) continue;
      lines.push(later.length === 1
        ? `• ${info.name}: Zählung vom ${deDate(later[0])}`
        : `• ${info.name}: ${later.length} Zählungen vom ${deDate(later[0])} bis ${deDate(later[later.length - 1])}`);
    }
    if (!lines.length) return;
    const msg = `Diese Buchung betrifft bereits erfasste Kassenzählungen:\n\n${lines.join('\n')}\n\n`
      + 'Der gezählte Bestand bleibt, Buchbestand und Differenz (z. B. Einnahmen ohne Einzelbeleg) werden neu berechnet. Fortfahren?';
    if (!window.confirm(msg)) e.preventDefault();
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

  /*
   * Bereiche nur unter Bedingungen zeigen: data-show-if="nonprofit" (Kontrollkästchen angehakt),
   * "org_type=association" (Auswahl/Radio hat diesen Wert); mehrere Bedingungen mit Leerzeichen = alle.
   */
  document.querySelectorAll('[data-show-if]').forEach((el) => {
    const form = el.closest('form');
    if (!form) return;
    const conds = el.dataset.showIf.split(' ').map((c) => {
      const [name, value] = c.split('=');
      return { name, value, fields: [...form.querySelectorAll(`[name="${name}"]`)] };
    });
    if (conds.some((c) => !c.fields.length)) return;
    const met = (c) => {
      if (c.value === undefined) return c.fields.some((f) => f.checked);
      return c.fields.some((f) => (f.type === 'radio' ? f.checked && f.value === c.value : f.value === c.value));
    };
    const sync = () => (el.hidden = !conds.every(met));
    conds.forEach((c) => c.fields.forEach((f) => f.addEventListener('change', sync)));
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

  /* ---------- Kassenzählung: Summen je Stückelung und gesamt ---------- */
  document.querySelectorAll('[data-count-form]').forEach((form) => {
    const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
    const total = form.querySelector('[data-count-total]');
    const sync = () => {
      let sum = 0;
      form.querySelectorAll('[data-denom]').forEach((input) => {
        const n = Math.max(0, Math.floor(Number(input.value) || 0));
        const cents = n * Number(input.dataset.denom);
        sum += cents;
        const cell = input.closest('tr')?.querySelector('[data-denom-sum]');
        if (cell) cell.textContent = n ? eur.format(cents / 100) : '–';
      });
      if (total) total.textContent = eur.format(sum / 100);
    };
    form.addEventListener('input', sync);
    sync();
  });

  /* ---------- Bereich (Gemeinnützigkeit): Erklärung als Tooltip und Text zum gewählten Bereich ---------- */
  document.querySelectorAll('[data-sphere-select]').forEach((select) => {
    const hint = select.closest('label')?.querySelector('[data-sphere-hint]');
    const sync = () => {
      const o = select.selectedOptions[0];
      if (!o) return;
      select.title = `${o.dataset.hint} Beispiele: ${o.dataset.examples}`;
      if (hint) {
        hint.replaceChildren();
        const strong = document.createElement('strong');
        strong.textContent = o.dataset.hint;
        hint.append(strong, ` z. B. ${o.dataset.examples}`);
      }
    };
    select.addEventListener('change', sync);
    sync();
  });

  /* ---------- Belege anhängen: Foto aufnehmen / Datei wählen, mehrere nacheinander, Fotos verkleinern ---------- */
  const MAX_EDGE = 2000;
  const shrink = async (file) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      const name = (file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg';
      return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
    } catch {
      return file; // z. B. HEIC in Browsern ohne Unterstützung – der Server meldet sich dann
    }
  };

  /* ---------- Bilder zuschneiden (Dialog) ----------
   * cropImage(quelle, { skip }) öffnet den Dialog für eine Datei/Blob oder eine Adresse.
   * Ergebnis: { action: 'apply', file } | { action: 'skip' } | { action: 'cancel' }.
   * Drehen in 90°-Schritten, Rahmen aufziehen, verschieben, an Ecken und Kanten ziehen –
   * mit Maus und Finger (Pointer Events). Ausgabe: PNG bleibt PNG, sonst JPEG.
   */
  const cropImage = (() => {
    let dlg = null;
    const els = {};
    const st = { bmp: null, rot: 0, scale: 1, w: 0, h: 0, box: null, type: 'image/jpeg', name: 'bild', resolve: null };
    const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const MIN = 24;

    const build = () => {
      dlg = document.createElement('dialog');
      dlg.className = 'cropper';
      dlg.innerHTML = `
        <div class="cropper-head"><strong>Zuschneiden</strong>
          <span class="muted small">Rahmen aufziehen, verschieben oder an den Ecken ziehen</span></div>
        <div class="cropper-stage" data-stage><canvas></canvas>
          <div class="cropper-box" data-box>${HANDLES.map((h) => `<span class="cropper-h ${h}" data-h="${h}"></span>`).join('')}</div></div>
        <div class="cropper-tools">
          <button type="button" class="btn small ghost" data-rot="-1" title="Nach links drehen">⟲ Drehen</button>
          <button type="button" class="btn small ghost" data-rot="1" title="Nach rechts drehen">⟳ Drehen</button>
          <button type="button" class="btn small ghost" data-full>Ganzes Bild</button>
        </div>
        <div class="cropper-actions">
          <button type="button" class="btn ghost" data-cancel>Abbrechen</button>
          <button type="button" class="btn" data-skip>Ohne Zuschneiden</button>
          <button type="button" class="btn primary" data-apply>Übernehmen</button>
        </div>`;
      document.body.append(dlg);
      els.stage = dlg.querySelector('[data-stage]');
      els.canvas = dlg.querySelector('canvas');
      els.box = dlg.querySelector('[data-box]');
      els.skip = dlg.querySelector('[data-skip]');
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish({ action: 'cancel' });
      });
      dlg.querySelector('[data-cancel]').addEventListener('click', () => finish({ action: 'cancel' }));
      els.skip.addEventListener('click', () => finish({ action: 'skip' }));
      dlg.querySelector('[data-apply]').addEventListener('click', apply);
      dlg.querySelector('[data-full]').addEventListener('click', () => {
        st.box = { x: 0, y: 0, w: st.w, h: st.h };
        st.prev = { ...st.box };
        placeBox();
      });
      dlg.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => {
        st.rot = (st.rot + Number(b.dataset.rot) + 4) % 4;
        layout();
      }));
      bindPointer();
      window.addEventListener('resize', () => dlg.open && layout());
    };

    // Abmessungen des gedrehten Bildes in voller Auflösung
    const rotSize = () => (st.rot % 2 ? [st.bmp.height, st.bmp.width] : [st.bmp.width, st.bmp.height]);
    // Transformation „gedrehtes Bild“ → Zeichenfläche (nach evtl. Skalierung/Verschiebung)
    const rotate = (ctx) => {
      const { width: bw, height: bh } = st.bmp;
      if (st.rot === 1) { ctx.translate(bh, 0); ctx.rotate(Math.PI / 2); }
      if (st.rot === 2) { ctx.translate(bw, bh); ctx.rotate(Math.PI); }
      if (st.rot === 3) { ctx.translate(0, bw); ctx.rotate(-Math.PI / 2); }
      ctx.drawImage(st.bmp, 0, 0);
    };

    const layout = () => {
      const [rw, rh] = rotSize();
      const maxW = Math.min(window.innerWidth - 48, 960);
      const maxH = Math.max(200, window.innerHeight - 230);
      st.scale = Math.min(maxW / rw, maxH / rh, 1);
      st.w = Math.round(rw * st.scale);
      st.h = Math.round(rh * st.scale);
      const dpr = window.devicePixelRatio || 1;
      els.canvas.width = Math.round(st.w * dpr);
      els.canvas.height = Math.round(st.h * dpr);
      els.canvas.style.width = `${st.w}px`;
      els.canvas.style.height = `${st.h}px`;
      els.stage.style.width = `${st.w}px`;
      els.stage.style.height = `${st.h}px`;
      const ctx = els.canvas.getContext('2d');
      ctx.setTransform(st.scale * dpr, 0, 0, st.scale * dpr, 0, 0);
      rotate(ctx);
      // Startrahmen mit etwas Abstand – so sieht man sofort, dass er sich ziehen lässt
      const m = Math.round(Math.min(st.w, st.h) * 0.04);
      st.box = { x: m, y: m, w: st.w - 2 * m, h: st.h - 2 * m };
      st.prev = { ...st.box };
      placeBox();
    };

    const placeBox = () => {
      const b = st.box;
      Object.assign(els.box.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    };

    const bindPointer = () => {
      let drag = null;
      const pt = (e) => {
        const r = els.stage.getBoundingClientRect();
        return { x: Math.max(0, Math.min(st.w, e.clientX - r.left)), y: Math.max(0, Math.min(st.h, e.clientY - r.top)) };
      };
      els.stage.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        e.preventDefault();
        const p = pt(e);
        const h = e.target.closest('[data-h]')?.dataset.h;
        const b = { ...st.box };
        if (h) drag = { mode: h, p, b };
        else if (e.target.closest('[data-box]')) drag = { mode: 'move', p, b };
        else drag = { mode: 'new', p, b: { x: p.x, y: p.y, w: 0, h: 0 } };
        els.stage.setPointerCapture(e.pointerId);
      });
      els.stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const p = pt(e);
        const dx = p.x - drag.p.x;
        const dy = p.y - drag.p.y;
        const o = drag.b;
        let { x, y, w, h } = o;
        if (drag.mode === 'move') {
          x = Math.max(0, Math.min(st.w - w, o.x + dx));
          y = Math.max(0, Math.min(st.h - h, o.y + dy));
        } else if (drag.mode === 'new') {
          x = Math.min(drag.p.x, p.x);
          y = Math.min(drag.p.y, p.y);
          w = Math.abs(dx);
          h = Math.abs(dy);
        } else {
          const m = drag.mode;
          if (m.includes('w')) { x = Math.min(o.x + o.w - MIN, Math.max(0, o.x + dx)); w = o.x + o.w - x; }
          if (m.includes('e')) w = Math.max(MIN, Math.min(st.w - o.x, o.w + dx));
          if (m.includes('n')) { y = Math.min(o.y + o.h - MIN, Math.max(0, o.y + dy)); h = o.y + o.h - y; }
          if (m.includes('s')) h = Math.max(MIN, Math.min(st.h - o.y, o.h + dy));
        }
        st.box = { x, y, w, h };
        placeBox();
      });
      const end = () => {
        if (!drag) return;
        // versehentlicher Klick ohne Ziehen: alten Rahmen behalten
        if (st.box.w < MIN || st.box.h < MIN) st.box = drag.mode === 'new' ? { ...st.prev } : drag.b;
        st.prev = { ...st.box };
        drag = null;
        placeBox();
      };
      els.stage.addEventListener('pointerup', end);
      els.stage.addEventListener('pointercancel', end);
    };

    async function apply() {
      const b = st.box;
      const sx = b.x / st.scale;
      const sy = b.y / st.scale;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(b.w / st.scale));
      out.height = Math.max(1, Math.round(b.h / st.scale));
      const ctx = out.getContext('2d');
      if (st.type !== 'image/png') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, out.width, out.height);
      }
      ctx.translate(-sx, -sy);
      rotate(ctx);
      let blob = await new Promise((r) => out.toBlob(r, st.type, 0.9));
      // sehr große PNGs (z. B. Fotos als PNG) lieber als JPEG
      if (blob && st.type === 'image/png' && blob.size > 8 * 1024 * 1024) blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9));
      if (!blob) return finish({ action: 'cancel' });
      const ext = blob.type === 'image/png' ? '.png' : '.jpg';
      finish({ action: 'apply', file: new File([blob], st.name.replace(/\.[^.]+$/, '') + ext, { type: blob.type, lastModified: Date.now() }) });
    }

    const finish = (result) => {
      if (dlg?.open) dlg.close();
      st.bmp?.close?.();
      st.bmp = null;
      const r = st.resolve;
      st.resolve = null;
      r?.(result);
    };

    return async (source, opts = {}) => {
      if (typeof createImageBitmap !== 'function' || typeof HTMLDialogElement !== 'function') return { action: 'skip' };
      if (!dlg) build();
      let blob = source;
      if (typeof source === 'string') {
        const res = await fetch(source, { credentials: 'same-origin' });
        if (!res.ok) {
          window.alert('Das Bild konnte nicht geladen werden.');
          return { action: 'cancel' };
        }
        blob = await res.blob();
      }
      if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) return { action: 'skip' };
      try {
        st.bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));
      } catch {
        return { action: 'skip' };
      }
      st.rot = 0;
      st.type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
      st.name = opts.name || blob.name || 'beleg.jpg';
      els.skip.hidden = !opts.skip;
      dlg.showModal();
      layout();
      return new Promise((resolve) => { st.resolve = resolve; });
    };
  })();

  /** Datei an Position i eines Dateifelds ersetzen */
  const replaceFile = (input, i, file) => {
    const dt = new DataTransfer();
    [...input.files].forEach((f, k) => dt.items.add(k === i ? file : f));
    input.files = dt.files;
  };
  const isImg = (f) => /^image\/(jpeg|png|webp)$/.test(f.type);

  /* Nachträglich zuschneiden (Belege): Knopf mit data-crop-action / data-crop-reset */
  const postForm = (action, csrf, fill) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = action;
    form.enctype = 'multipart/form-data';
    form.hidden = true;
    const token = document.createElement('input');
    token.type = 'hidden';
    token.name = '_csrf';
    token.value = csrf;
    form.append(token);
    fill(form);
    document.body.append(form);
    form.submit();
  };
  document.addEventListener('click', async (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-crop-action], [data-crop-reset]') : null;
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.cropReset) {
      if (btn.dataset.confirmText && !window.confirm(btn.dataset.confirmText)) return;
      return postForm(btn.dataset.cropReset, btn.dataset.csrf, (form) => {
        const r = document.createElement('input');
        r.type = 'hidden';
        r.name = 'reset';
        r.value = '1';
        form.append(r);
      });
    }
    btn.disabled = true;
    try {
      const res = await cropImage(btn.dataset.cropSrc);
      if (res.action !== 'apply') return;
      postForm(btn.dataset.cropAction, btn.dataset.csrf, (form) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.name = 'image';
        const dt = new DataTransfer();
        dt.items.add(res.file);
        input.files = dt.files;
        form.append(input);
      });
    } finally {
      btn.disabled = false;
    }
  });

  /* Einzelnes Bild beim Auswählen zuschneiden (z. B. Logo): input[data-crop-pick] */
  document.querySelectorAll('input[type="file"][data-crop-pick]').forEach((input) => {
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f || !isImg(f)) return;
      const res = await cropImage(f, { skip: true });
      if (res.action === 'apply') replaceFile(input, 0, res.file);
      else if (res.action === 'cancel') input.value = '';
    });
  });
  document.querySelectorAll('[data-entry-files]').forEach((box) => {
    const list = box.querySelector('[data-file-list]');
    const holder = document.createElement('div');
    holder.hidden = true;
    box.append(holder);
    const refresh = () => {
      list.replaceChildren();
      holder.querySelectorAll('input[type="file"]').forEach((input) => {
        [...input.files].forEach((f, i) => {
          const li = document.createElement('li');
          li.textContent = `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB) `;
          if (isImg(f)) {
            const crop = document.createElement('button');
            crop.type = 'button';
            crop.className = 'link';
            crop.textContent = 'zuschneiden';
            crop.addEventListener('click', async () => {
              const res = await cropImage(f);
              if (res.action === 'apply') {
                replaceFile(input, i, res.file);
                refresh();
              }
            });
            li.append(crop, ' · ');
          }
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'link danger';
          rm.textContent = 'entfernen';
          rm.addEventListener('click', () => {
            input.remove();
            refresh();
          });
          li.append(rm);
          list.append(li);
        });
      });
      list.hidden = !list.children.length;
    };
    const onPick = async (input) => {
      if (!input.files.length) return;
      // gefülltes Feld beiseitelegen (wird mitgeschickt), ein leeres für das nächste Foto einsetzen
      const fresh = input.cloneNode();
      fresh.value = '';
      input.after(fresh);
      bind(fresh);
      holder.append(input);
      const dt = new DataTransfer();
      for (const f of input.files) dt.items.add(await shrink(f));
      input.files = dt.files;
      // frisch fotografiert: gleich zuschneiden anbieten
      if (input.hasAttribute('capture') && input.files.length === 1 && isImg(input.files[0])) {
        const res = await cropImage(input.files[0], { skip: true });
        if (res.action === 'apply') replaceFile(input, 0, res.file);
        else if (res.action === 'cancel') input.remove();
      }
      refresh();
    };
    const bind = (input) => input.addEventListener('change', () => onPick(input));
    box.querySelectorAll('input[data-shrink]').forEach(bind);
  });

  /* ---------- Ein Foto aufnehmen und sofort hochladen (Eingangsrechnungen) ---------- */
  document.querySelectorAll('[data-photo-submit]').forEach((form) => {
    const input = form.querySelector('input[type="file"]');
    input.addEventListener('change', async () => {
      if (!input.files.length) return;
      const dt = new DataTransfer();
      for (const f of input.files) dt.items.add(await shrink(f));
      input.files = dt.files;
      if (input.files.length === 1 && isImg(input.files[0])) {
        const res = await cropImage(input.files[0], { skip: true });
        if (res.action === 'cancel') {
          input.value = '';
          return;
        }
        if (res.action === 'apply') replaceFile(input, 0, res.file);
      }
      form.classList.add('busy');
      form.submit();
    });
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
    // Fotos in der Auswahl lassen sich vor dem Hochladen zuschneiden (Liste unter dem Ablagefeld)
    const picks = document.createElement('ul');
    picks.className = 'plain file-picks small';
    zone.after(picks);
    const show = () => {
      const files = [...(input.files || [])];
      list.hidden = !files.length;
      list.textContent = files.length ? `${files.length} Datei(en) ausgewählt` : '';
      picks.replaceChildren();
      files.forEach((f, i) => {
        const li = document.createElement('li');
        li.textContent = `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB) `;
        if (isImg(f)) {
          const crop = document.createElement('button');
          crop.type = 'button';
          crop.className = 'link';
          crop.textContent = 'zuschneiden';
          crop.addEventListener('click', async () => {
            const res = await cropImage(f);
            if (res.action === 'apply') {
              replaceFile(input, i, res.file);
              show();
            }
          });
          li.append(crop);
        }
        picks.append(li);
      });
      picks.hidden = !files.length;
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
    // select[...] – die Lieferanten-Optionen tragen selbst ein data-category-Attribut
    const category = pform.querySelector('select[data-category]');
    if (supplier && newSupplier) {
      const sync = (fromUser) => {
        newSupplier.hidden = !!supplier.value;
        const cat = supplier.selectedOptions[0]?.dataset.category;
        if (fromUser && cat && category) category.value = cat;
      };
      supplier.addEventListener('change', () => sync(true));
      sync(false);
    }

    // Kassenbuch: Konto nur zeigen und verlangen, wenn „Bezahlt am“ gesetzt ist
    const paidAt = pform.querySelector('[data-paid-at]');
    const paidAccount = pform.querySelector('[data-paid-account]');
    if (paidAt && paidAccount) {
      const select = paidAccount.querySelector('select');
      const syncPaid = () => {
        paidAccount.hidden = !paidAt.value;
        select.required = !!paidAt.value;
      };
      paidAt.addEventListener('input', syncPaid);
      paidAt.addEventListener('change', syncPaid);
      syncPaid();
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
