let CRYPTO_DIGEST = 'SHA-256';
let CRYPTO_ALG = 'AES-GCM';

const encryptText = async (plainText, password) => {
  const ptUtf8 = new TextEncoder().encode(plainText);
  const pwUtf8 = new TextEncoder().encode(password);
  const pwHash = await crypto.subtle.digest(CRYPTO_DIGEST, pwUtf8); 
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const alg = { name: CRYPTO_ALG, iv: iv };
  const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['encrypt']);
  return { iv, encBuffer: await crypto.subtle.encrypt(alg, key, ptUtf8) };
}

const decryptText = async (ctBuffer, iv, password) => {
  const pwUtf8 = new TextEncoder().encode(password);
  const pwHash = await crypto.subtle.digest(CRYPTO_DIGEST, pwUtf8);
  const alg = { name: CRYPTO_ALG, iv: iv };
  const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['decrypt']);
  const ptBuffer = await crypto.subtle.decrypt(alg, key, ctBuffer);
  const plaintext = new TextDecoder().decode(ptBuffer);
  return plaintext;
}