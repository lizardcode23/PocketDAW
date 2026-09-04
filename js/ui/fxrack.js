// The per-channel effect rack: add, reorder, bypass and edit effects.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { EFFECT_TYPES, EFFECT_INFO, EFFECT_PARAMS, defaultParams } from '../audio/effects.js';
import { el, clear, sheet, slider, icon, ICONS, toast, confirmSheet } from './dom.js';

export function renderFxRack(container, track, { onChange } = {}) {
  const repaint = () => { renderFxRack(container, track, { onChange }); onChange && onChange(); };
  const apply = () => { engine.syncFx(track); S.touch(); };

  clear(container);
  const list = el('div', { class: 'fxlist' });

  if (!track.fx || !track.fx.length) {
    list.append(el('div', { class: 'empty', style: { padding: '16px' } },
      'No effects on this channel yet.'));
  }

  (track.fx || []).forEach((fx, i) => {
    const info = EFFECT_INFO[fx.type] || { name: fx.type, blurb: '' };
    const row = el('div', { class: `fxrow${fx.on === false ? ' off' : ''}` },
      el('button', {
        class: 'fxpower', 'aria-label': fx.on === false ? 'Enable' : 'Bypass',
        onclick: () => {
          fx.on = fx.on === false;
          apply();
          repaint();
        },
      }, icon(fx.on === false ? ICONS.power : ICONS.check, 15)),
      el('button', {
        class: 'fxmeta',
        onclick: () => openFxSheet(track, fx, { onChange: repaint }),
      },
        el('b', {}, info.name),
        el('span', {}, summarise(fx)),
      ),
      el('div', { class: 'fxmove' },
        el('button', {
          'aria-label': 'Move earlier', disabled: i === 0,
          onclick: () => { S.checkpoint(); swap(track.fx, i, i - 1); apply(); repaint(); },
        }, icon(ICONS.up, 14)),
        el('button', {
          'aria-label': 'Move later', disabled: i === track.fx.length - 1,
          onclick: () => { S.checkpoint(); swap(track.fx, i, i + 1); apply(); repaint(); },
        }, icon(ICONS.chevDown, 14)),
      ),
      el('button', {
        class: 'kill', 'aria-label': `Remove ${info.name}`,
        onclick: () => {
          S.checkpoint();
          track.fx.splice(i, 1);
          apply();
          repaint();
        },
      }, icon(ICONS.trash, 17)),
    );
    list.append(row);
  });

  container.append(
    list,
    el('button', {
      class: 'btn wide', style: { marginTop: '10px' },
      onclick: () => openAddEffect(track, { onChange: repaint }),
    }, icon(ICONS.plus, 18), 'Add effect'),
    el('p', { class: 'hint' },
      'Effects run top to bottom, then the channel fader. The same chain is used when you export.'),
  );
}

const swap = (arr, a, b) => { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; };

function summarise(fx) {
  const params = EFFECT_PARAMS[fx.type] || [];
  const values = fx.params || {};
  const parts = params.slice(0, 2).map((p) => {
    const v = values[p.key];
    if (v == null) return null;
    if (p.options) return String(v);
    const num = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
    return `${p.label} ${num}${p.unit ? ` ${p.unit}` : ''}`;
  }).filter(Boolean);
  return fx.on === false ? 'bypassed' : parts.join(' · ');
}

function openAddEffect(track, { onChange } = {}) {
  sheet('Add effect', (body, close) => {
    body.append(el('div', { class: 'slist' },
      EFFECT_TYPES.map((type) => el('button', {
        class: 'sitem', style: { width: '100%' },
        onclick: () => {
          S.checkpoint();
          track.fx = track.fx || [];
          track.fx.push({ id: S.uid('fx'), type, on: true, params: defaultParams(type) });
          engine.syncFx(track);
          S.touch();
          close();
          toast(`${EFFECT_INFO[type].name} added to ${track.name}`, 'ok');
          onChange && onChange();
        },
      },
        el('span', { class: 'play' }, icon(ICONS.tune, 15)),
        el('span', { class: 'meta' },
          el('b', {}, EFFECT_INFO[type].name),
          el('span', {}, EFFECT_INFO[type].blurb)),
      )),
    ));
  });
}

function openFxSheet(track, fx, { onChange } = {}) {
  const info = EFFECT_INFO[fx.type] || { name: fx.type };
  sheet(`${info.name} · ${track.name}`, (body, close) => {
    fx.params = fx.params || defaultParams(fx.type);
    const apply = () => { engine.syncFx(track); S.touch(); };

    const card = el('div', { class: 'card' });
    for (const p of EFFECT_PARAMS[fx.type] || []) {
      if (p.options) {
        const pills = el('div', { class: 'pills' },
          p.options.map((opt) => {
            const b = el('button', {
              class: `pill${fx.params[p.key] === opt ? ' on' : ''}`,
              onclick: () => {
                fx.params[p.key] = opt;
                [...pills.children].forEach((c) => c.classList.toggle('on', c === b));
                apply();
              },
            }, opt);
            return b;
          }));
        card.append(el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, p.label), pills));
      } else {
        card.append(slider(p.label, {
          min: p.min, max: p.max, step: p.step, value: fx.params[p.key] ?? p.def,
          format: (v) => formatValue(v, p),
          oninput: (v) => { fx.params[p.key] = v; apply(); },
        }));
      }
    }

    body.append(card, el('div', { class: 'btnrow' },
      el('button', {
        class: 'btn',
        onclick: () => { fx.params = defaultParams(fx.type); apply(); close(); onChange && onChange(); },
      }, 'Reset'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!await confirmSheet('Remove effect?', `${info.name} will be taken off ${track.name}.`, 'Remove')) return;
          S.checkpoint();
          track.fx.splice(track.fx.indexOf(fx), 1);
          apply();
          close();
          onChange && onChange();
        },
      }, icon(ICONS.trash, 18), 'Remove'),
    ));
  });
}

function formatValue(v, p) {
  if (p.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
  if (p.unit === 's') return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`;
  if (p.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  if (p.unit === 'steps') return `${v}/16`;
  if (p.max <= 1.5) return `${Math.round(v * 100)}%`;
  return v.toFixed(2);
}
