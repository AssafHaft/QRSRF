# QRSRF — One-time-use QR codes

A small self-hosted web app that generates batches of unique QR codes, each redeemable **exactly once**. Built for handing out benefits (free coffee, discount, entry pass…) to customers.

- **Admin dashboard** — generate batches, assign recipients, see who redeemed and when, void codes, export CSV, print a QR sheet.
- **Single-use guarantee** — redemption is an atomic SQLite update; two simultaneous scans can never both succeed.
- **Safe against link previews** — scanning shows the offer with a *Redeem now* button; the code is only consumed when the button is pressed, so WhatsApp/email link prefetchers can't burn it.
- **Optional expiration** — set a date per batch; expired codes stop working automatically.
- **Zero native dependencies** — Node.js ≥ 22.5 (uses the built-in `node:sqlite`), Express, and the pure-JS `qrcode` package.

## Run locally

```powershell
npm install
$env:ADMIN_PASSWORD = "choose-a-password"   # protects /admin and /api
npm start
```

Open http://localhost:3000/admin (any username, the password you set).

## How it works

1. **Create a batch** — give it a label, the benefit text customers see, an optional expiry, and either a count or a pasted recipient list (`Name, email/phone` per line — one code per recipient).
2. **Send codes** — per code: click the QR thumbnail for a large QR + *Copy link* / *Download PNG*, or use *Print sheet* for the whole batch. Send the link or image by WhatsApp/email/print — all free. Click *Mark sent* to track delivery.
3. **Customer scans** — they see the offer and a *Redeem now* button. Pressing it (ideally with staff watching) marks the code used forever. Re-scans show "Already redeemed" with the timestamp.
4. **Track** — the dashboard shows live status per code (active / used / expired / void), plus CSV export.

## Configuration (environment variables)

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Password for the admin panel (HTTP Basic auth). **Set this in production.** | *(unset = no auth, dev only)* |
| `PORT` | HTTP port | `3000` |
| `BASE_URL` | Public URL used inside QR codes, e.g. `https://promo.example.com`. If unset, derived from the request. | *(derived)* |
| `DATA_DIR` | Where the SQLite file lives | `./data` |

## Deploying (free / low-cost)

The app is a single Node process with a SQLite file — it needs a host with a **persistent disk**:

- **Fly.io** — small VM + 1 GB volume fits the free-allowance tier. Set `DATA_DIR=/data` and mount a volume there.
- **Railway** — hobby plan (~$5/mo) with a volume.
- **Any VPS** (Hetzner/Lightsail, ~$4/mo) — `node server.js` behind Caddy/nginx for HTTPS.

Avoid serverless platforms (Vercel/Netlify) — their filesystems are ephemeral, so the SQLite data would be lost between deploys.

Set `BASE_URL` to your public HTTPS URL so QR codes encode the right address, and always set `ADMIN_PASSWORD`.
