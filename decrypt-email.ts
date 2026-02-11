import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'fs';

// Ed25519 to X25519 conversion
// tweetnacl doesn't expose this directly, but the ed25519 secret key's first 32 bytes
// can be used with crypto_sign_ed25519_sk_to_curve25519
// We'll use the nacl.box approach with the ed25519-to-curve25519 package

async function main() {
  // Load wallet
  const walletData = JSON.parse(readFileSync('/root/.zolty-keypair.json', 'utf8'));
  const keypair = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
  console.log('Wallet:', keypair.publicKey.toBase58());

  // Get the message
  const resp = await fetch('http://localhost:3001/email/inboxes/2e21af3b-340d-4865-8947-ddc824577c8f/messages', {
    headers: { 'Authorization': 'Bearer aos_n8t7pr3qzmgoxmxxmumzfwkef3jqhfzjp4u9y89325jlyf0l' }
  });
  const data = await resp.json() as any;
  
  if (!data.messages?.length) {
    console.log('No messages');
    return;
  }

  const msg = data.messages[0];
  console.log('Message ID:', msg.id);
  console.log('Direction:', msg.direction);
  console.log('Encrypted subject:', msg.subject?.slice(0, 60));
  console.log('Encrypted body:', msg.body?.slice(0, 60));

  // The encrypted data should be: ephemeralPubKey (32 bytes) + nonce (24 bytes) + ciphertext
  // All base64 encoded
  
  // Convert Ed25519 secret key to X25519 (Curve25519)
  // nacl.sign.keyPair.fromSecretKey gives us the ed25519 keypair
  // The first 32 bytes of ed25519 secret key is the seed
  const ed25519SecretKey = keypair.secretKey; // 64 bytes
  
  // Use tweetnacl's lowlevel to convert
  // Actually, tweetnacl doesn't have ed25519_sk_to_curve25519
  // Let's use the hash-based approach: SHA-512 the seed, clamp
  const { createHash } = await import('crypto');
  const seed = ed25519SecretKey.slice(0, 32);
  const hash = createHash('sha512').update(seed).digest();
  const x25519SecretKey = new Uint8Array(32);
  hash.copy(Buffer.from(x25519SecretKey.buffer), 0, 0, 32);
  x25519SecretKey[0] &= 248;
  x25519SecretKey[31] &= 127;
  x25519SecretKey[31] |= 64;

  function tryDecrypt(encrypted: string): string | null {
    try {
      const raw = Buffer.from(encrypted, 'base64');
      if (raw.length < 56) return null; // 32 + 24 + at least 1 byte
      
      const ephemeralPubKey = raw.slice(0, 32);
      const nonce = raw.slice(32, 56);
      const ciphertext = raw.slice(56);
      
      const decrypted = nacl.box.open(
        new Uint8Array(ciphertext),
        new Uint8Array(nonce),
        new Uint8Array(ephemeralPubKey),
        x25519SecretKey
      );
      
      if (decrypted) {
        return new TextDecoder().decode(decrypted);
      }
      return null;
    } catch (e) {
      console.error('Decrypt error:', e);
      return null;
    }
  }

  // Try to decrypt subject and body
  if (msg.subject) {
    const subject = tryDecrypt(msg.subject);
    console.log('\n📧 Subject:', subject || '[decryption failed]');
  }
  
  if (msg.body) {
    const body = tryDecrypt(msg.body);
    console.log('📝 Body:', body ? body.slice(0, 500) : '[decryption failed]');
  }

  // Also try the raw fields
  for (const field of Object.keys(msg)) {
    if (field === 'id' || field === 'inboxId' || field === 'direction' || field === 'createdAt') continue;
    if (typeof msg[field] === 'string' && msg[field].length > 20) {
      const dec = tryDecrypt(msg[field]);
      if (dec) {
        console.log(`✅ ${field}:`, dec.slice(0, 200));
      }
    }
  }
}

main().catch(console.error);
