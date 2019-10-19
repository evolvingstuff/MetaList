"use strict";

const DEFAULT_CRYPTO_DIGEST = 'SHA-256';
const DEFAULT_CRYPTO_ALG = 'AES-GCM';

const encryptText = async (plainText, password) => {
  const ptUtf8 = new TextEncoder().encode(plainText);
  const pwUtf8 = new TextEncoder().encode(password);
  const pwHash = await crypto.subtle.digest(DEFAULT_CRYPTO_DIGEST, pwUtf8); 
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const alg = { name: DEFAULT_CRYPTO_ALG, iv: iv };
  const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['encrypt']);
  return { iv, encBuffer: await crypto.subtle.encrypt(alg, key, ptUtf8) };
}

const decryptText = async (ctBuffer, iv, digest, alg_name, password) => {
  const pwUtf8 = new TextEncoder().encode(password);
  const pwHash = await crypto.subtle.digest(digest, pwUtf8);
  const alg = { name: alg_name, iv: iv };
  const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['decrypt']);
  const ptBuffer = await crypto.subtle.decrypt(alg, key, ctBuffer);
  const plaintext = new TextDecoder().decode(ptBuffer);
  return plaintext;
}