/* =========================================================================
   Overlay UI: toasts, modals, confirm dialogs and the command palette.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc } = BN.util;
  const icon = BN.icon;

  /* --------------------------------------------------------------------- */
  /* Toasts                                                                 */

  const ICONS = { info: 'info', ok: 'checkCircle', warn: 'alert', error: 'xCircle' };

  function toast(title, body = '', { kind = 'info', ms = 5200, action = null } = {}) {
    const host = document.getElementById('toasts');
    if (!host) return;

    const node = el('div', { class: `toast ${kind}`, role: 'status' });
    node.innerHTML = `
      <div class="toast-icon">${icon(ICONS[kind] || 'info')}</div>
      <div class="grow">
        <div class="toast-title">${esc(title)}</div>
        ${body ? `<div class="toast-body">${esc(body)}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="Dismiss">${icon('x')}</button>
      <i class="toast-life" style="animation-duration:${ms}ms"></i>`;

    if (action) {
      const btn = el('button', { class: 'btn btn-sm btn-ghost', style: { alignSelf: 'center' } }, action.label);
      btn.addEventListener('click', () => {
        action.onClick?.();
        dismiss();
      });
      node.querySelector('.toast-close').before(btn);
    }

    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      node.classList.add('out');
      node.addEventListener('animationend', () => node.remove(), { once: true });
    };

    node.querySelector('.toast-close').addEventListener('click', dismiss);
    node.addEventListener('pointerenter', () => {
      clearTimeout(timer);
      node.querySelector('.toast-life').style.animationPlayState = 'paused';
    });
    node.addEventListener('pointerleave', () => {
      node.querySelector('.toast-life').style.animationPlayState = 'running';
      timer = setTimeout(dismiss, 1600);
    });

    host.appendChild(node);
    // Keep the stack short so a burst of events cannot bury the screen.
    while (host.children.length > 4) host.firstElementChild.remove();
    timer = setTimeout(dismiss, ms);
    BN.sound?.play(kind === 'error' ? 'error' : kind === 'ok' ? 'success' : 'notify');
    return dismiss;
  }

  /* --------------------------------------------------------------------- */
  /* Modal                                                                  */

  let openModal = null;

  /**
   * Opens a modal. `content` may be a node or an HTML string; `footer` takes
   * an array of button descriptors.
   */
  function modal({ title, content, footer = [], wide = false, onClose = null, chrome = true }) {
    closeModal(true);

    const overlay = el('div', { class: 'overlay' });
    const box = el('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });

    if (chrome) {
      const head = el('div', { class: 'modal-head' });
      head.innerHTML = `<h2 class="display" style="font-size:1rem">${esc(title || '')}</h2>`;
      const close = el('button', { class: 'modal-close', 'aria-label': 'Close' });
      close.innerHTML = icon('x');
      close.addEventListener('click', () => closeModal());
      head.appendChild(close);
      box.appendChild(head);
    }

    const body = el('div', { class: 'modal-body' });
    if (typeof content === 'string') body.innerHTML = content;
    else if (content) body.appendChild(content);
    box.appendChild(body);

    if (footer.length) {
      const foot = el('div', { class: 'modal-foot' });
      for (const spec of footer) {
        const btn = el('button', { class: `btn ${spec.class || 'btn-ghost'}` }, spec.label);
        btn.addEventListener('click', () => spec.onClick?.({ close: closeModal, body }));
        foot.appendChild(btn);
      }
      box.appendChild(foot);
    }

    overlay.appendChild(box);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);

    openModal = { overlay, onClose };
    BN.sound?.play('open');

    // Move focus in so Escape and Tab behave.
    (box.querySelector('input, button, select, textarea') || box).focus?.();
    return { overlay, box, body, close: closeModal };
  }

  function closeModal(immediate = false) {
    if (!openModal) return;
    const { overlay, onClose } = openModal;
    openModal = null;
    onClose?.();
    if (immediate) {
      overlay.remove();
      return;
    }
    BN.sound?.play('close');
    overlay.classList.add('out');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
  }

  /** Promise-based confirm dialog. Resolves true when the user commits. */
  function confirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      modal({
        title,
        content: `<p style="color:var(--text-dim);line-height:1.7">${esc(message)}</p>`,
        onClose: () => finish(false),
        footer: [
          { label: cancelLabel, class: 'btn-ghost', onClick: ({ close }) => { finish(false); close(); } },
          {
            label: confirmLabel,
            class: danger ? 'btn-danger' : 'btn-accent',
            onClick: ({ close }) => { finish(true); close(); }
          }
        ]
      });
    });
  }

  /* --------------------------------------------------------------------- */
  /* Command palette                                                        */

  let paletteNode = null;
  let paletteItems = [];
  let paletteIndex = 0;

  function commandPalette(commands) {
    if (paletteNode) return closePalette();

    const overlay = el('div', { class: 'palette-overlay' });
    const box = el('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' });
    box.innerHTML = `
      <div class="palette-input">
        ${icon('command')}
        <input type="text" placeholder="Search games, jump to a page, run a command..." aria-label="Command" spellcheck="false">
        <kbd>ESC</kbd>
      </div>
      <div class="palette-list" role="listbox"></div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paletteNode = overlay;
    BN.sound?.play('open');

    const input = box.querySelector('input');
    const list = box.querySelector('.palette-list');

    /** Ranks a command against the query: a label hit always beats a hit that
     *  only came from a genre or tag, so typing "play" surfaces Play commands
     *  before every title tagged "Single-player". */
    const score = (cmd, q) => {
      const label = cmd.label.toLowerCase();
      if (label === q) return 100;
      if (label.startsWith(q)) return 80;
      if (label.includes(q)) return 60;
      if ((cmd.group || '').toLowerCase().includes(q)) return 30;
      if ((cmd.keywords || '').toLowerCase().includes(q)) return 20;
      return 0;
    };

    const render = (query = '') => {
      const q = query.trim().toLowerCase();
      let matched;

      if (!q) {
        matched = commands.filter((c) => !c.hidden);
      } else {
        const scored = commands
          .map((cmd, index) => ({ cmd, index, s: score(cmd, q) }))
          .filter((entry) => entry.s > 0);

        // Order groups by their best hit, then keep each group's items together
        // so headings never repeat down the list.
        const best = new Map();
        for (const entry of scored) {
          const key = entry.cmd.group || '';
          if (!best.has(key) || best.get(key) < entry.s) best.set(key, entry.s);
        }
        scored.sort(
          (a, b) =>
            best.get(b.cmd.group || '') - best.get(a.cmd.group || '') ||
            (a.cmd.group || '').localeCompare(b.cmd.group || '') ||
            b.s - a.s ||
            a.index - b.index
        );
        matched = scored.map((entry) => entry.cmd);
      }

      paletteItems = matched;
      paletteIndex = 0;
      list.innerHTML = '';

      if (!matched.length) {
        list.innerHTML = `<div class="palette-empty">Nothing matches "${esc(query)}"</div>`;
        return;
      }

      let group = null;
      matched.forEach((cmd, i) => {
        if (cmd.group !== group) {
          group = cmd.group;
          list.appendChild(el('div', { class: 'palette-group', text: group || 'Commands' }));
        }
        const item = el('button', { class: 'palette-item', role: 'option', 'aria-selected': i === 0 });
        item.innerHTML = `${icon(cmd.icon || 'arrowRight')}<span>${esc(cmd.label)}</span>${cmd.hint ? `<span class="hint">${esc(cmd.hint)}</span>` : ''}`;
        item.addEventListener('click', () => run(cmd));
        item.addEventListener('pointerenter', () => select(i));
        list.appendChild(item);
      });
    };

    const select = (i) => {
      paletteIndex = (i + paletteItems.length) % paletteItems.length;
      const nodes = list.querySelectorAll('.palette-item');
      nodes.forEach((n, idx) => n.setAttribute('aria-selected', idx === paletteIndex));
      nodes[paletteIndex]?.scrollIntoView({ block: 'nearest' });
    };

    const run = (cmd) => {
      closePalette();
      BN.sound?.play('click');
      setTimeout(() => cmd.run?.(), 60);
    };

    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); select(paletteIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(paletteIndex - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (paletteItems[paletteIndex]) run(paletteItems[paletteIndex]); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });

    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) closePalette();
    });

    render('');
    input.focus();
  }

  function closePalette() {
    if (!paletteNode) return;
    const node = paletteNode;
    paletteNode = null;
    BN.sound?.play('close');
    node.style.animation = 'fade-in 140ms ease reverse forwards';
    setTimeout(() => node.remove(), 150);
  }

  /* --------------------------------------------------------------------- */
  /* Lightweight dropdown                                                   */

  let openDropdown = null;

  function dropdown(anchor, node) {
    closeDropdown();
    anchor.setAttribute('aria-expanded', 'true');
    anchor.parentElement.appendChild(node);
    openDropdown = { anchor, node };

    const away = (e) => {
      if (!node.contains(e.target) && !anchor.contains(e.target)) closeDropdown();
    };
    setTimeout(() => document.addEventListener('pointerdown', away), 0);
    openDropdown.away = away;
    return node;
  }

  function closeDropdown() {
    if (!openDropdown) return;
    const { anchor, node, away } = openDropdown;
    openDropdown = null;
    document.removeEventListener('pointerdown', away);
    anchor.setAttribute('aria-expanded', 'false');
    node.style.animation = 'menu-in 150ms ease reverse forwards';
    setTimeout(() => node.remove(), 155);
  }

  /* Global escape handling ---------------------------------------------- */

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (paletteNode) closePalette();
    else if (openDropdown) closeDropdown();
    else if (openModal) closeModal();
  });

  BN.ui = { toast, modal, closeModal, confirm, commandPalette, closePalette, dropdown, closeDropdown };
})();
