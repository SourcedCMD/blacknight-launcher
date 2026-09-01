/* =========================================================================
   Sign in / create account.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { $, esc } = BN.util;
  const icon = BN.icon;

  let mode = 'signin';
  let revealed = false;

  function render() {
    const host = $('#auth-form-host');
    if (!host) return;

    host.innerHTML = mode === 'signin' ? signInForm() : signUpForm();
    host.firstElementChild?.classList.add('swap');

    $('#auth-tab-signin').setAttribute('aria-selected', mode === 'signin');
    $('#auth-tab-signup').setAttribute('aria-selected', mode === 'signup');

    wire();
  }

  /** Names the legal documents, linking only the ones that have a home. */
  function legalLine() {
    const { hasLink, link } = BN.util;
    const doc = (key, label) =>
      hasLink(key) ? `<a href="#" data-external="${esc(link(key))}">${label}</a>` : label;
    return `By continuing you agree to the BlackNight Studios ${doc('terms', 'Terms of Service')} and ${doc('privacy', 'Privacy Policy')}.`;
  }

  const passwordField = (id, placeholder, autocomplete) => `
    <div class="field">
      <label class="field-label" for="${id}">Password</label>
      <div class="input-wrap">
        ${icon('lock')}
        <input class="input" id="${id}" type="${revealed ? 'text' : 'password'}"
               placeholder="${placeholder}" autocomplete="${autocomplete}" spellcheck="false">
        <button type="button" class="reveal" data-tip="${revealed ? 'Hide' : 'Show'}" aria-label="Toggle password visibility"
                style="color:var(--text-mute);display:flex">${icon(revealed ? 'eyeOff' : 'eye')}</button>
      </div>
    </div>`;

  function signInForm() {
    return `
    <form class="auth-form" id="form-signin" novalidate>
      <div class="auth-rows">
        <div class="field">
          <label class="field-label" for="si-id">Email or handle</label>
          <div class="input-wrap">
            ${icon('mail')}
            <input class="input" id="si-id" type="text" placeholder="you@example.com" autocomplete="username" spellcheck="false" autofocus>
          </div>
        </div>
        ${passwordField('si-pw', 'Enter your password', 'current-password')}
        <div class="between" style="margin-top:2px">
          <button type="button" class="row" id="si-remember" style="gap:9px">
            <span class="check" role="checkbox" aria-checked="true">${icon('check')}</span>
            <span style="font-size:.82rem;color:var(--text-dim)">Keep me signed in</span>
          </button>
          <button type="button" class="link-btn" id="si-forgot">Forgot password?</button>
        </div>
        <div id="si-error"></div>
        <button type="submit" class="btn btn-chrome btn-lg btn-block" id="si-submit" style="margin-top:6px">
          ${icon('arrowRight')} Sign in
        </button>
      </div>

      <div class="auth-alt">or</div>

      <button type="button" class="btn btn-ghost btn-block" id="si-offline">
        ${icon('wifiOff')} Continue offline
      </button>

      <p class="auth-foot">
        No account yet? <button type="button" class="link-btn" data-goto="signup">Create one</button><br>
        ${legalLine()}
      </p>
    </form>`;
  }

  function signUpForm() {
    return `
    <form class="auth-form" id="form-signup" novalidate>
      <div class="auth-rows">
        <div class="field">
          <label class="field-label" for="su-email">Email</label>
          <div class="input-wrap">
            ${icon('mail')}
            <input class="input" id="su-email" type="email" placeholder="you@example.com" autocomplete="email" spellcheck="false" autofocus>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="su-handle">Handle</label>
          <div class="input-wrap">
            ${icon('user')}
            <input class="input" id="su-handle" type="text" placeholder="NightRunner" autocomplete="nickname" spellcheck="false" maxlength="20">
          </div>
          <span class="field-hint">3-20 characters. Letters, numbers and underscores. This is how other players see you.</span>
        </div>
        ${passwordField('su-pw', 'At least 8 characters', 'new-password')}
        <div class="strength" id="su-strength" data-score="0"><i></i><i></i><i></i><i></i><i></i></div>
        <span class="field-hint" id="su-strength-label">Use upper and lowercase, a number or a symbol.</span>

        <button type="button" class="row" id="su-terms" style="gap:10px;align-items:flex-start;margin-top:4px">
          <span class="check" role="checkbox" aria-checked="false" style="margin-top:1px">${icon('check')}</span>
          <span style="font-size:.8rem;color:var(--text-dim);text-align:left;line-height:1.5">
            I am 13 or older and accept the Terms of Service and Privacy Policy.
          </span>
        </button>

        <div id="su-error"></div>
        <button type="submit" class="btn btn-chrome btn-lg btn-block" id="su-submit" style="margin-top:6px">
          ${icon('sparkles')} Create account
        </button>
      </div>

      <p class="auth-foot">
        Already have an account? <button type="button" class="link-btn" data-goto="signin">Sign in</button>
      </p>
    </form>`;
  }

  /* --------------------------------------------------------------------- */

  const showError = (hostId, message) => {
    const host = document.getElementById(hostId);
    host.innerHTML = message ? `<div class="field-error">${esc(message)}</div>` : '';
    if (message) BN.sound?.play('error');
  };

  const toggleCheck = (node) => {
    const box = node.querySelector('.check');
    const next = box.getAttribute('aria-checked') !== 'true';
    box.setAttribute('aria-checked', String(next));
    BN.sound?.play('toggle');
    return next;
  };

  function busy(button, on, label) {
    button.disabled = on;
    button.dataset.label = button.dataset.label || button.innerHTML;
    button.innerHTML = on ? `<span class="spinner"></span> ${esc(label)}` : button.dataset.label;
  }

  function wire() {
    const host = $('#auth-form-host');

    host.querySelectorAll('[data-goto]').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.goto;
        render();
      })
    );

    host.querySelectorAll('[data-external]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        BN.api.app.openExternal(a.dataset.external);
      })
    );

    const reveal = host.querySelector('.reveal');
    reveal?.addEventListener('click', () => {
      revealed = !revealed;
      const input = host.querySelector('#si-pw, #su-pw');
      const value = input.value;
      input.type = revealed ? 'text' : 'password';
      input.value = value;
      reveal.innerHTML = icon(revealed ? 'eyeOff' : 'eye');
      reveal.dataset.tip = revealed ? 'Hide' : 'Show';
      input.focus();
    });

    if (mode === 'signin') wireSignIn(host);
    else wireSignUp(host);
  }

  function wireSignIn(host) {
    let remember = true;
    host.querySelector('#si-remember').addEventListener('click', (e) => {
      remember = toggleCheck(e.currentTarget);
    });

    host.querySelector('#si-forgot').addEventListener('click', () => {
      BN.ui.modal({
        title: 'Reset your password',
        content: `<p style="color:var(--text-dim);line-height:1.7">
            Password resets are handled by the BlackNight account service. Once the studio's
            account backend is connected, this sends a reset link to your registered email.
          </p>
          <p style="color:var(--text-mute);margin-top:14px;font-size:.82rem">
            Running locally? Accounts live on this machine only, so create a new one instead.
          </p>`,
        footer: [{ label: 'Got it', class: 'btn-accent', onClick: ({ close }) => close() }]
      });
    });

    host.querySelector('#si-offline').addEventListener('click', async () => {
      const result = await BN.state.signInOffline();
      if (result.ok) finish();
    });

    host.querySelector('#form-signin').addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = host.querySelector('#si-id').value;
      const password = host.querySelector('#si-pw').value;
      const submit = host.querySelector('#si-submit');

      if (!identifier || !password) return showError('si-error', 'Enter your credentials to continue.');

      showError('si-error', '');
      busy(submit, true, 'Signing in');
      const result = await BN.state.signIn({ identifier, password, remember });
      busy(submit, false);

      if (!result.ok) {
        showError('si-error', result.error);
        host.querySelector('#si-pw').closest('.input-wrap').classList.add('invalid');
        return;
      }
      finish();
    });
  }

  function wireSignUp(host) {
    let accepted = false;
    host.querySelector('#su-terms').addEventListener('click', (e) => {
      accepted = toggleCheck(e.currentTarget);
    });

    const pw = host.querySelector('#su-pw');
    const meter = host.querySelector('#su-strength');
    const label = host.querySelector('#su-strength-label');
    const LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Excellent'];

    pw.addEventListener('input', async () => {
      const score = await BN.api.auth.strength(pw.value);
      meter.dataset.score = score;
      label.textContent = pw.value ? LABELS[score] : 'Use upper and lowercase, a number or a symbol.';
    });

    host.querySelector('#form-signup').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = host.querySelector('#su-submit');
      if (!accepted) return showError('su-error', 'Please accept the Terms of Service to continue.');

      showError('su-error', '');
      busy(submit, true, 'Creating');
      const result = await BN.state.signUp({
        email: host.querySelector('#su-email').value,
        handle: host.querySelector('#su-handle').value,
        password: pw.value
      });
      busy(submit, false);

      if (!result.ok) return showError('su-error', result.error);

      BN.ui.toast('Welcome to BlackNight', `Your account is ready, ${result.user.handle}.`, { kind: 'ok' });
      finish();
    });
  }

  function finish() {
    BN.sound?.play('launch');
    const auth = $('#auth');
    auth.classList.add('out');
    setTimeout(() => {
      auth.classList.add('hidden');
      BN.app.start();
    }, 560);
  }

  /* --------------------------------------------------------------------- */

  /** Cinematic left panel: a slow scrolling starfield behind the copy. */
  function paintArt(canvas) {
    const ctx = canvas.getContext('2d');
    let raf;
    let stars = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round((canvas.clientWidth * canvas.clientHeight) / 3400);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.clientWidth,
        y: Math.random() * canvas.clientHeight,
        r: Math.random() * 1.5 + 0.2,
        v: 0.04 + Math.random() * 0.22,
        tw: Math.random() * Math.PI * 2
      }));
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // Moon
      const mx = w * 0.72;
      const my = h * 0.3;
      const glow = ctx.createRadialGradient(mx, my, 0, mx, my, h * 0.5);
      glow.addColorStop(0, 'rgba(190,210,250,0.22)');
      glow.addColorStop(1, 'rgba(190,210,250,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      ctx.beginPath();
      ctx.arc(mx, my, Math.min(w, h) * 0.1, 0, Math.PI * 2);
      const face = ctx.createRadialGradient(mx - 12, my - 12, 4, mx, my, Math.min(w, h) * 0.1);
      face.addColorStop(0, '#ffffff');
      face.addColorStop(1, '#8d99b0');
      ctx.fillStyle = face;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;

      for (const s of stars) {
        s.x -= s.v;
        s.tw += 0.02;
        if (s.x < -2) { s.x = w + 2; s.y = Math.random() * h; }
        ctx.globalAlpha = 0.25 + Math.sin(s.tw) * 0.2 + 0.3;
        ctx.fillStyle = '#dce6ff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    window.addEventListener('resize', resize);
    resize();
    if (document.documentElement.dataset.motion !== 'reduced') frame();
    else { resize(); }
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }

  BN.views = BN.views || {};
  BN.views.auth = {
    mount() {
      $('#auth-mark').innerHTML = BN.art.logo(92);
      paintArt($('#auth-canvas'));

      $('#auth-tab-signin').addEventListener('click', () => { mode = 'signin'; render(); });
      $('#auth-tab-signup').addEventListener('click', () => { mode = 'signup'; render(); });

      render();
    },
    setMode(next) {
      mode = next;
      render();
    }
  };
})();
