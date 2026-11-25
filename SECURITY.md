# Security policy

Please report vulnerabilities privately to **support@oddomens.com** or through a GitHub security advisory, not in a public issue. Include steps to reproduce and the version (Settings → About). We aim to reply within 3 working days.

## Deployment checklist

- [ ] Quire is only reachable from this machine, your LAN or your VPN. `QUIRE_BIND` is `127.0.0.1` unless you chose otherwise.
- [ ] Remote access goes over HTTPS (Tailscale Serve or a reverse proxy), and the proxy's address is in `QUIRE_TRUSTED_PROXIES`.
- [ ] Two-factor sign-in is on, and the recovery codes are saved somewhere other than the server.
- [ ] `QUIRE_DATA_DIR` (database and `secret.key`) and `QUIRE_NOTES_DIR` are readable only by the user Quire runs as.
- [ ] Both folders are backed up. Backups to Coffer go to an encrypted drive.
- [ ] `QUIRE_PUBLIC_LISTEN` is unset unless you want public forms on the internet, and only that port is exposed.

## What Quire does not do

Pages are plain Markdown files, and Quire does not encrypt them or its database on disk. Anyone who can read the notes and data folders on the server can read your pages. If that matters, keep both folders on an encrypted disk.
