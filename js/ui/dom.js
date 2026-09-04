// Tiny DOM helpers plus the bottom-sheet and toast primitives every view uses.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        // Custom properties need setProperty; plain assignment silently drops them.
        if (prop.startsWith('--')) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    }
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/** Inline SVG icon from a path string. */
export function icon(d, size = 22) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.width = svg.style.height = `${size}px`;
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export const ICONS = {
  play: 'M8 5v14l11-7z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  trash: 'M6 7h12l-1 13H7L6 7zm3-4h6l1 2H8l1-2z',
  close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z',
  pencil: 'M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.9 1.9 3.8 3.8 1.9-1.9z',
  eraser: 'M15.1 3.5 20.5 8.9a2 2 0 0 1 0 2.8L13 19.2H8.4l-4-4a2 2 0 0 1 0-2.8l8-8a2 2 0 0 1 2.7 0zM6.9 14.9l2.3 2.3h3l1.7-1.7-4.6-4.6-2.4 2.4z',
  copy: 'M8 4h10a2 2 0 0 1 2 2v10h-2V6H8V4zM4 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
  down: 'M12 16 6 10h4V4h4v6h4l-6 6zM4 18h16v2H4z',
  wave: 'M3 12h2l2-6 3 14 3-11 2 5h6',
  folder: 'M3 5h6l2 2h10v12H3z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  dice: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-4 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-4 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  lock: 'M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm3 8V7a3 3 0 0 0-6 0v3h6z',
  fold: 'M4 5h16v2H4zm3 5h10v2H7zm-3 5h16v2H4z',
  minus: 'M5 11h14v2H5z',
  save: 'M5 3h11l3 3v15H5V3zm2 2v5h8V5H7zm0 9v5h10v-5H7z',
  bulb: 'M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2zM9 19h6v2H9v-2z',
  power: 'M12 3h2v9h-2V3zm-3.6 2.1 1.4 1.4A6 6 0 1 0 18 12a6 6 0 0 0-2.8-5.1l1.4-1.4A8 8 0 1 1 4 12a8 8 0 0 1 4.4-6.9z',
  up: 'M12 7l6 7H6z',
  layers: 'M12 3 2 8l10 5 10-5-10-5zm-7.8 8.2L2 12.3l10 5 10-5-2.2-1.1L12 14.8l-7.8-3.6z',
  chevDown: 'M12 17 6 10h12z',
  tune: 'M4 6h9v2H4zm13 0h3v2h-3zM4 11h3v2H4zm7 0h9v2h-9zM4 16h11v2H4zm15 0h1v2h-1z',
  mic: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-4 4.9V19h3v2H8v-2h3v-3.1A5 5 0 0 1 7 11h2a3 3 0 0 0 6 0h2z',
  record: 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  stop: 'M7 7h10v10H7z',
  cut: 'M9.6 12 4.2 6.6a3 3 0 1 1 1.4-1.4L12 11.6l6.4-6.4a3 3 0 1 1 1.4 1.4L14.4 12l5.4 5.4a3 3 0 1 1-1.4 1.4L12 12.4l-6.4 6.4a3 3 0 1 1-1.4-1.4L9.6 12zM4 4.5a1.2 1.2 0 1 0 1.7 1.7A1.2 1.2 0 0 0 4 4.5zm0 13.3a1.2 1.2 0 1 0 1.7 1.7 1.2 1.2 0 0 0-1.7-1.7z',
  wand: 'M6.8 2.5 8 5.9l3.4 1.2L8 8.3 6.8 11.7 5.6 8.3 2.2 7.1 5.6 5.9 6.8 2.5zm10 4L18 9l2.5 1.2L18 11.5l-1.2 2.5-1.2-2.5L13 10.2 15.6 9l1.2-2.5zM13.6 12l2.4 2.4-9.6 9.6L4 21.6 13.6 12z',
};

/* ------------------------------------------------------------- toasts */

export function toast(message, kind = '') {
  const root = $('#toastRoot');
  const node = el('div', { class: `toast ${kind}` }, message);
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, kind === 'err' ? 4200 : 2200);
}

/* ------------------------------------------------------------- sheets */

let closeCurrent = null;

/**
 * Open a bottom sheet. `build(body, close)` fills the scrollable body.
 * Returns a close function.
 */
export function sheet(title, build) {
  const root = $('#sheetRoot');
  if (closeCurrent) closeCurrent();

  const body = el('div', { class: 'sheet-body' });
  const close = () => {
    root.hidden = true;
    clear(root);
    if (closeCurrent === close) closeCurrent = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'sheet-grab' }),
    el('div', { class: 'sheet-head' },
      el('h2', {}, title),
      el('button', { class: 'close', 'aria-label': 'Close', onclick: close }, icon(ICONS.close, 18)),
    ),
    body,
  );

  clear(root).append(el('div', { class: 'sheet-scrim', onclick: close }), panel);
  root.hidden = false;
  closeCurrent = close;
  document.addEventListener('keydown', onKey);
  build(body, close);
  return close;
}

/** Simple yes/no confirmation rendered as a sheet. */
export function confirmSheet(title, message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    let answered = false;
    const close = sheet(title, (body) => {
      body.append(
        el('p', { class: 'hint', style: { fontSize: '13.5px', color: 'var(--text-dim)' } }, message),
        el('div', { class: 'btnrow', style: { marginTop: '14px' } },
          el('button', { class: 'btn ghost', onclick: () => { answered = true; close(); resolve(false); } }, 'Cancel'),
          el('button', {
            class: `btn ${confirmLabel === 'Delete' ? 'danger' : 'primary'}`,
            onclick: () => { answered = true; close(); resolve(true); },
          }, confirmLabel),
        ),
      );
    });
    const root = $('#sheetRoot');
    const observer = new MutationObserver(() => {
      if (root.hidden && !answered) { answered = true; observer.disconnect(); resolve(false); }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['hidden'] });
  });
}

/** Label + range input + live value readout. */
export function slider(label, { min, max, step = 0.01, value, format = (v) => v.toFixed(2), oninput }) {
  const out = el('span', { class: 'val' }, format(value));
  const input = el('input', {
    type: 'range', min, max, step, value,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      out.textContent = format(v);
      oninput(v);
    },
  });
  return el('div', { class: 'row' }, el('span', { class: 'lbl' }, label), input, out);
}

export const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
