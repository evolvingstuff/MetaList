# https://nitratine.net/blog/post/python-gcm-encryption-tutorial/
from Cryptodome.Cipher import AES
import lorem
from Cryptodome.Protocol.KDF import scrypt
from Cryptodome.Util.number import long_to_bytes
import time


def main():
    # https://stackoverflow.com/questions/67307689/decrypt-an-encrypted-message-with-aes-gcm-in-python
    number = 1
    orig_msg = ''
    for i in range(10_000):
        orig_msg += lorem.paragraph() + '\n'
    print(orig_msg)
    pw = 'my-dumb-password'
    secret_data = bytes(orig_msg, 'utf-8')
    key = scrypt(long_to_bytes(number), bytes(pw, 'utf-8'), 32, N=2 ** 10, r=8, p=1)
    hex_key = key.hex()
    cipher = AES.new(key, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(secret_data)
    hex_enc_msg = (cipher.nonce + ciphertext + tag).hex()
    print(f'{hex_enc_msg}')
    t1 = time.time()
    key = bytes.fromhex(hex_key)
    data = bytes.fromhex(hex_enc_msg)
    cipher = AES.new(key, AES.MODE_GCM, data[:16])  # nonce
    try:
        dec_msg = cipher.decrypt_and_verify(data[16:-16], data[-16:]).decode('utf-8')  # ciphertext, tag
        t2 = time.time()
        assert dec_msg == orig_msg
        print(dec_msg)
        print(f'{((t2-t1)*1000):.4f} ms to decrypt')

    except ValueError:
        print("Decryption failed")


if __name__ == '__main__':
    main()