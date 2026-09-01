/* =========================================================================
   Moving a setup to another machine.

   One side shows a code and a QR of the same link; the other types the code.
   The QR is there because a link is easier to photograph than to transcribe,
   and because a phone is usually closer than a keyboard.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc } = BN.util;
  const icon = BN.icon;

  let countdown = null;

  /* --------------------------------------------------------------------- */
  /* Sending                                                                */

  async function send() {
    const result = await BN.api.handoff.start();
    if (!result.ok) {
      BN.ui.toast('Could not start the handoff', result.error || '', { kind: 'error' });
      return;
    }

    const body = el('div', { class: 'handoff' });
    body.innerHTML = `
      <p class="dim" style="line-height:1.7">
        On the other machine, open <b>Settings &rarr; Account &rarr; Bring my setup across</b>
        and enter this code. Both machines have to be on the same network.
      </p>

      <div class="handoff-code" role="group" aria-label="Pairing code">
        ${[...result.code].map((ch) => `<span>${esc(ch)}</span>`).join('')}
      </div>

      <div class="handoff-qr">${BN.qr.svg(result.url, { size: 176 })}</div>

      <div class="handoff-meta">
        <span class="mono">${esc(result.host)}:${esc(String(result.port))}</span>
        <span id="handoff-left"></span>
      </div>

      <p class="field-hint" style="margin-top:14px">
        Settings, your library records and your play history travel.
        Accounts and passwords never do, and the code works once.
      </p>`;

    const left = body.querySelector('#handoff-left');
    const tick = () => {
      const remaining = Math.max(0, result.expiresAt - Date.now());
      if (!remaining) {
        left.textContent = 'expired';
        clearInterval(countdown);
        return;
      }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      left.textContent = `expires in ${m}:${String(s).padStart(2, '0')}`;
    };
    tick();
    clearInterval(countdown);
    countdown = setInterval(tick, 1000);

    BN.ui.modal({
      title: 'Bring this setup to another machine',
      content: body,
      onClose: () => {
        clearInterval(countdown);
        BN.api.handoff.stop();
      },
      footer: [{ label: 'Done', class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  /* --------------------------------------------------------------------- */
  /* Receiving                                                              */

  function receive(prefill = null) {
    const body = el('div');
    body.innerHTML = `
      <p class="dim" style="line-height:1.7">
        On the machine you are moving from, open
        <b>Settings &rarr; Account &rarr; Send my setup</b>, then enter what it shows.
      </p>
      <div class="field" style="margin-top:16px">
        <label class="field-label" for="ho-host">Address</label>
        <div class="input-wrap">
          <input class="input mono" id="ho-host" placeholder="192.168.1.20:8431"
                 value="${prefill ? esc(`${prefill.host}:${prefill.port}`) : ''}" spellcheck="false">
        </div>
      </div>
      <div class="field" style="margin-top:12px">
        <label class="field-label" for="ho-code">Code</label>
        <div class="input-wrap">
          <input class="input mono" id="ho-code" placeholder="ABC123" maxlength="6"
                 value="${prefill ? esc(prefill.code) : ''}"
                 style="letter-spacing:.3em;text-transform:uppercase" spellcheck="false">
        </div>
      </div>
      <div id="ho-error"></div>`;

    const code = body.querySelector('#ho-code');
    code.addEventListener('input', () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });

    BN.ui.modal({
      title: 'Bring my setup across',
      content: body,
      footer: [
        { label: BN.t('action.cancel'), class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Bring it across',
          class: 'btn-accent',
          onClick: async ({ close, body: root }) => {
            const [host, port] = (root.querySelector('#ho-host').value || '').split(':');
            const entered = root.querySelector('#ho-code').value;
            const error = root.querySelector('#ho-error');

            if (!host || !port || entered.length !== 6) {
              error.innerHTML = '<div class="field-error">An address and a six-character code are needed.</div>';
              return;
            }

            const result = await BN.api.handoff.receive({ host, port: Number(port), code: entered });
            if (!result.ok) {
              error.innerHTML = `<div class="field-error">${esc(result.error || 'That did not work.')}</div>`;
              return;
            }

            close();
            await BN.state.loadSettings();
            await BN.state.refreshLibrary();
            BN.app.paintTimeOfDay();
            BN.ui.toast(
              'Setup brought across',
              `${result.settings} preferences and ${result.added} library record${result.added === 1 ? '' : 's'}. Installed games stay on the machine they are on.`,
              { kind: 'ok', ms: 9000 }
            );
          }
        }
      ]
    });
  }

  BN.views = BN.views || {};
  BN.views.handoff = { send, receive };
})();
