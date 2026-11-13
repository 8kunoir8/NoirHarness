# ADR-0009: A paired browser is a device row, not a second token

Status: accepted (2026-11-13)

The kernel's LAN listener accepts an `HttpOnly` cookie whose value is a random device secret. Only
an HMAC-SHA256 digest of it is stored, in a `devices` row with a name, a creation time and a last-seen
time.

Reason: the runtime token is a file on the machine that owns the kernel; handing it to a phone would
make it a second copy of that file with no way to tell two phones apart. A row lets a device be
revoked, its revocation close live sockets, and the list show what each device is doing. Storing a
digest means the database is not a copy of any live credential.

Pairing redeems a one-time code carried in the URL fragment, with a ten-minute TTL, five attempts per
code and five per address per minute; the fragment is never sent to the kernel as part of a request
line, so it stays out of logs.

The listener also refuses any `Origin` that is not the address it advertises, and answers only
loopback callers unless remote access is explicitly enabled.
