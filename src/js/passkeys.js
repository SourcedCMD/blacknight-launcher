/* =========================================================================
   Passkeys.

   The honest state of this, stated plainly because the alternative is a
   switch that lies:

   Registration works end to end where the platform provides WebAuthn — the
   browser creates a credential, and the server stores its id and public key.

   Sign-in with a passkey is deliberately NOT offered. Verifying an assertion
   means parsing CBOR and checking a signature against the stored key, and the
   server says in its own comments that this belongs behind a reviewed library
   rather than being improvised. Until that exists, a "sign in with a passkey"
   button could only either fail or accept anything — and the second is worse
   than not having the button.

   So this enrols, reports what it can do, and says the rest out loud.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  /**
   * Whether this runtime can create a passkey at all.
   *
   * Electron loading from file:// does not provide WebAuthn, so in the
   * packaged launcher this is false today and the UI says so rather than
   * offering a button that throws.
   */
  function available() {
    return (
      typeof navigator !== 'undefined' &&
      navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof PublicKeyCredential !== 'undefined'
    );
  }

  /** Whether a server is configured to hold the credential. */
  const configured = () => !!(BN.state?.data?.settings?.accountsUrl || '').trim();

  /**
   * What the UI should say, in one place.
   *
   * Three different reasons this can be unavailable, and a user is owed the
   * actual one rather than a greyed-out control.
   */
  function status() {
    if (!configured()) {
      return { ok: false, reason: 'not-configured', text: 'No account service is configured, so there is nowhere to keep a passkey.' };
    }
    if (!available()) {
      return { ok: false, reason: 'unsupported', text: 'This build cannot create passkeys — the launcher window does not provide WebAuthn.' };
    }
    return {
      ok: true,
      text: 'You can add a passkey. Signing in with one is not available yet: the server stores it but does not yet verify a signature.'
    };
  }

  const base64url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const fromBase64url = (text) => {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };

  /**
   * Enrols a passkey for the signed-in account.
   *
   * The challenge comes from the server and goes back with the credential, so
   * a stored passkey is at least tied to a challenge the server issued —
   * which is the part that is meaningful without full verification.
   */
  async function add() {
    const state = status();
    if (!state.ok) return { ok: false, error: state.text };

    const user = BN.state.data.user;
    if (!user) return { ok: false, error: 'Sign in first.' };

    try {
      const challenge = await BN.api.account.passkeyChallenge?.(user.id);
      if (!challenge?.challenge) return { ok: false, error: 'The server did not issue a challenge.' };

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: fromBase64url(challenge.challenge),
          rp: { name: 'BlackNight Studios', id: challenge.rpId },
          user: {
            id: Uint8Array.from(user.id, (c) => c.charCodeAt(0)),
            name: user.email || user.handle,
            displayName: user.displayName || user.handle
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },   // ES256
            { type: 'public-key', alg: -257 }  // RS256
          ],
          authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
          timeout: 60000,
          attestation: 'none'
        }
      });

      if (!credential) return { ok: false, error: 'No passkey was created.' };

      const saved = await BN.api.account.passkeyRegister?.({
        userId: user.id,
        credentialId: credential.id,
        publicKey: base64url(credential.response.getPublicKey?.() || new ArrayBuffer(0)),
        challenge: challenge.challenge
      });

      return saved?.ok ? { ok: true, count: saved.count } : { ok: false, error: saved?.error || 'The server refused it.' };
    } catch (err) {
      // A cancelled prompt is a choice, not a failure.
      if (err?.name === 'NotAllowedError') return { ok: false, cancelled: true };
      BN.log?.warn('passkeys', 'Enrolment failed', err);
      return { ok: false, error: err.message };
    }
  }

  BN.passkeys = { available, configured, status, add };
})();
