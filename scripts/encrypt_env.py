#!/usr/bin/env python3
# Objective: Encrypt a plaintext .env file into .env.enc.
# Requirements: Use AES-256-GCM with a passphrase-derived key and iv:tag:ciphertext format.
# Decisions: Keep encryption dependency-free with Python's cryptography? Use openssl? Use cryptography if available.
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import argparse
import base64
import hashlib
import os
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    AESGCM = None


def encrypt(plaintext, key):
    if AESGCM is None:
        raise SystemExit("Install the 'cryptography' package to encrypt env files.")
    derived = hashlib.sha256(key.encode()).digest()
    iv = os.urandom(12)
    ciphertext = AESGCM(derived).encrypt(iv, plaintext.encode(), None)
    tag = ciphertext[-16:]
    body = ciphertext[:-16]
    return ":".join(
        base64.b64encode(part).decode() for part in (iv, tag, body)
    )


def main():
    parser = argparse.ArgumentParser(description="Encrypt a .env file")
    parser.add_argument("source", nargs="?", default=".env")
    parser.add_argument("destination", nargs="?", default=".env.enc")
    args = parser.parse_args()

    key = os.environ.get("WORKSPACE_ENV_KEY")
    if not key:
        raise SystemExit("WORKSPACE_ENV_KEY is required.")

    source = Path(args.source)
    destination = Path(args.destination)
    plaintext = source.read_text(encoding="utf-8")
    encrypted = encrypt(plaintext, key)
    destination.write_text(encrypted + "\n", encoding="utf-8")
    print(f"Encrypted {source} to {destination}")


if __name__ == "__main__":
    main()