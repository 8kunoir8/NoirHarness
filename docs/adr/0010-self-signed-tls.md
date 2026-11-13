# ADR-0010: A certificate the kernel signs itself

Status: accepted (2026-11-13)

The LAN listener serves TLS using a self-signed ECDSA P-256 certificate generated in-process, stored
as `<dataDir>/tls/{key,cert}.pem` with the key at mode `0600`, and reissued when the machine's
address set changes.

Reason: a paired cookie is a credential and, over plaintext, it is readable by anyone on the same
network. Node can mint keys and sign bytes but emits no X.509, and `openssl` cannot be assumed on a
Windows desktop, so the encoder is ~200 lines of DER and the file says so. A local CA distributed to
phones was rejected as a larger ask than one browser warning, and the fingerprint shown in the
Devices pane is the only verification a person can actually perform.

The loopback listener is untouched: plain HTTP on `127.0.0.1` with the runtime token, because a
local process that can read the runtime file is already the owner.
