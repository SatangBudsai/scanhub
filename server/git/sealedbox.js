// libsodium crypto_box_seal, as GitHub expects for Actions secrets:
// ephemeral keypair, nonce = blake2b(ephemeralPk || recipientPk, 24 bytes), output = ephemeralPk || box
import nacl from 'tweetnacl';
import blake from 'blakejs';

function nonceFor(epk, pk) {
  const input = new Uint8Array(epk.length + pk.length);
  input.set(epk);
  input.set(pk, epk.length);
  return blake.blake2b(input, undefined, nacl.box.nonceLength);
}

/** Encrypt a string for a base64 public key; returns base64 */
export function sealedBox(message, publicKeyB64) {
  const pk = new Uint8Array(Buffer.from(publicKeyB64, 'base64'));
  const eph = nacl.box.keyPair();
  const boxed = nacl.box(new Uint8Array(Buffer.from(message, 'utf8')), nonceFor(eph.publicKey, pk), pk, eph.secretKey);
  const out = new Uint8Array(eph.publicKey.length + boxed.length);
  out.set(eph.publicKey);
  out.set(boxed, eph.publicKey.length);
  return Buffer.from(out).toString('base64');
}

/** Open a sealed box (used by the tests to check the format) */
export function openSealedBox(cipherB64, publicKeyB64, secretKeyB64) {
  const c = new Uint8Array(Buffer.from(cipherB64, 'base64'));
  const pk = new Uint8Array(Buffer.from(publicKeyB64, 'base64'));
  const epk = c.subarray(0, nacl.box.publicKeyLength);
  const opened = nacl.box.open(c.subarray(nacl.box.publicKeyLength), nonceFor(epk, pk), epk, new Uint8Array(Buffer.from(secretKeyB64, 'base64')));
  return opened ? Buffer.from(opened).toString('utf8') : null;
}
