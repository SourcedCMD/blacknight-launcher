/* =========================================================================
   Passkeys.

   Both halves work now: the server parses the attestation, checks the
   signature against the stored key, pins the challenge and the origin, and
   refuses a signature counter that goes backwards.

   What is still true and worth saying: attestation statements are not
   verified, so this does not prove which make of authenticator created a
   credential. That check needs a trust store of vendor roots, and for signing
   somebody into their own launcher account it buys nothing — the security is
   in the signature, not the brand of the key.

   The remaining limitation is the runtime. Electron loading from file:// does
   not provide WebAuthn, so in the packaged launcher today `available()` is
   false and the UI says so rather than offering a button that throws.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  /** Whether this runtime can create or use a passkey at all. */
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
      return {
        ok: false,
        reason: 'not-configured',
        text: 'No account service is configured, so there is nowhere to keep a passkey.'
      };
    }
    if (!available()) {
      return {
        ok: false,
        reason: 'unsupported',
        text: 'This build cannot use passkeys — the launcher window does not provide WebAuthn.'
      };
    }
    return { ok: true, text: 'Add a passkey and you can sign in with it instead of a password.' };
  }

  const b64u = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const fromB64u = (text) => {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };

  /**
   * Enrols a passkey for the signed-in account.
   *
   * The whole attestation goes to the server, which is what lets it verify
   * rather than take the browser's word for the key. Nothing is extracted or
   * interpreted here: a client that pre-digests what the server is meant to
   * check is a client the server has to trust.
   */
  async function add() {
    const state = status();
    if (!state.ok) return { ok: false, error: state.text };

    const user = BN.state.data.user;
    if (!user) return { ok: false, error: 'Sign in first.' };

    try {
      const issued = await BN.api.account.passkeyChallenge(user.id);
      if (!issued?.challenge) return { ok: false, error: issued?.error || 'The server did not issue a challenge.' };

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: fromB64u(issued.challenge),
          rp: { name: 'BlackNight Studios', id: issued.rpId },
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

      const saved = await BN.api.account.passkeyRegister({
        userId: user.id,
        challenge: issued.challenge,
        attestationObject: b64u(credential.response.attestationObject),
        clientDataJSON: b64u(credential.response.clientDataJSON)
      });

      return saved?.ok
        ? { ok: true, count: saved.count }
        : { ok: false, error: saved?.error || 'The server refused it.' };
    } catch (err) {
      if (err?.name === 'NotAllowedError') return { ok: false, cancelled: true };
      BN.log?.warn('passkeys', 'Enrolment failed', err);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Signs in with a passkey.
   *
   * No account is named going in. The challenge is issued against nothing and
   * the credential the authenticator picks is what identifies the account, so
   * this cannot be used to find out whether an address is registered.
   */
  async function signIn() {
    const state = status();
    if (!state.ok) return { ok: false, error: state.text };

    try {
      const issued = await BN.api.account.passkeyLoginChallenge();
      if (!issued?.challenge) return { ok: false, error: issued?.error || 'The server did not issue a challenge.' };

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: fromB64u(issued.challenge),
          rpId: issued.rpId,
          userVerification: 'preferred',
          timeout: 60000
        }
      });

      if (!assertion) return { ok: false, error: 'No passkey was offered.' };

      const result = await BN.api.account.passkeyLogin({
        challenge: issued.challenge,
        credentialId: assertion.id,
        authenticatorData: b64u(assertion.response.authenticatorData),
        clientDataJSON: b64u(assertion.response.clientDataJSON),
        signature: b64u(assertion.response.signature)
      });

      if (!result?.ok) return { ok: false, error: result?.error || 'That passkey could not be verified.' };

      return { ok: true, user: result.user, token: result.token };
    } catch (err) {
      if (err?.name === 'NotAllowedError') return { ok: false, cancelled: true };
      BN.log?.warn('passkeys', 'Sign-in failed', err);
      return { ok: false, error: err.message };
    }
  }

  /** Removes a passkey from the signed-in account. */
  async function remove(credentialId) {
    const token = BN.state.data.remoteToken;
    if (!token) return { ok: false, error: 'Not signed in to the account service.' };
    return BN.api.account.passkeyRemove(token, credentialId);
  }

  BN.passkeys = { available, configured, status, add, signIn, remove };
})();
