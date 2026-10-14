// Key exchange, pairing codes and frame encryption for the peer link.
// Each session makes a fresh X25519 key pair. Both sides derive the same
// 6-digit code from the shared secret, so a man-in-the-middle shows different
// codes on the two screens. The same secret keys AES-256-GCM for every frame.
import crypto from 'node:crypto';

/** Creates this process's ephemeral identity key pair. */
export function newIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

/** Derives the pairing code, the link key and a short room tag for one peer. */
export function derivePair(privateKey, peerPub, myId, peerId) {
  const publicKey = crypto.createPublicKey({ key: Buffer.from(peerPub, 'base64'), format: 'der', type: 'spki' });
  const secret = crypto.diffieHellman({ privateKey, publicKey });
  const ids = [myId, peerId].sort().join('|');
  const digest = crypto.createHmac('sha256', secret).update(`claude-multiplayer/v1/code|${ids}`).digest();
  const digits = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(ids), 'claude-multiplayer/v1/key', 32));
  return { code: `${digits.slice(0, 3)} ${digits.slice(3)}`, key, room: digest.subarray(4, 6).toString('hex') };
}

/** Encrypts one frame object. */
export function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { t: 'e', n: iv.toString('base64'), d: body.toString('base64') };
}

/** Decrypts one frame; throws when the frame was not made with this key. */
export function open(key, frame) {
  const iv = Buffer.from(String(frame.n), 'base64');
  const body = Buffer.from(String(frame.d), 'base64');
  if (iv.length !== 12 || body.length < 17) throw new Error('bad frame');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}
