import express from 'express';
import QRCode from 'qrcode';
import path from 'node:path';
import * as db from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

app.use(express.json());

const baseUrl = (req) =>
  process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

const redeemUrl = (req, token) => `${baseUrl(req)}/r/${token}`;

// ---------- Admin auth (HTTP Basic) ----------

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next(); // dev mode, warned at startup
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, password] = Buffer.from(encoded, 'base64').toString().split(':');
    if (password === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="QRSRF admin"');
  res.status(401).send('Authentication required');
}

// ---------- Admin UI + API ----------

app.get('/', (req, res) => res.redirect('/admin'));
app.use('/admin', requireAdmin, express.static(path.join(import.meta.dirname, 'public')));
app.use('/api', requireAdmin);

app.post('/api/batches', (req, res) => {
  const { label, benefit, expiresAt, count, recipients } = req.body || {};
  const n = parseInt(count, 10) || 0;
  const list = Array.isArray(recipients) ? recipients : [];
  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: 'A batch label is required.' });
  }
  if (n < 1 && list.length === 0) {
    return res.status(400).json({ error: 'Specify how many codes to generate, or provide a recipient list.' });
  }
  if (Math.max(n, list.length) > 10000) {
    return res.status(400).json({ error: 'Maximum 10,000 codes per batch.' });
  }
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return res.status(400).json({ error: 'Invalid expiration date.' });
  }
  const batch = db.createBatch({
    label: label.trim(),
    benefit: (benefit || '').trim(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    count: n,
    recipients: list,
  });
  res.status(201).json(batch);
});

app.get('/api/batches', (req, res) => res.json(db.listBatches()));

app.get('/api/batches/:id/codes', (req, res) => {
  const batch = db.getBatch(Number(req.params.id));
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const codes = db.listCodes(batch.id).map((c) => ({
    ...c,
    state: db.codeState(c),
    link: redeemUrl(req, c.token),
  }));
  res.json({ batch, codes });
});

app.get('/api/batches/:id/export.csv', (req, res) => {
  const batch = db.getBatch(Number(req.params.id));
  if (!batch) return res.status(404).send('Batch not found');
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = [
    ['code_id', 'link', 'recipient_name', 'recipient_contact', 'status', 'sent_at', 'redeemed_at', 'expires_at'],
    ...db.listCodes(batch.id).map((c) => [
      c.id, redeemUrl(req, c.token), c.recipient_name, c.recipient_contact,
      db.codeState(c), c.sent_at, c.redeemed_at, c.expires_at,
    ]),
  ];
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="batch-${batch.id}-codes.csv"`);
  res.send(rows.map((r) => r.map(esc).join(',')).join('\r\n'));
});

app.put('/api/codes/:id/recipient', (req, res) => {
  const code = db.getCode(Number(req.params.id));
  if (!code) return res.status(404).json({ error: 'Code not found' });
  const { name, contact } = req.body || {};
  res.json(db.updateRecipient(code.id, { name, contact }));
});

app.post('/api/codes/:id/sent', (req, res) => {
  const code = db.getCode(Number(req.params.id));
  if (!code) return res.status(404).json({ error: 'Code not found' });
  res.json(db.markSent(code.id, !(req.body || {}).undo));
});

app.post('/api/codes/:id/void', (req, res) => {
  const code = db.getCode(Number(req.params.id));
  if (!code) return res.status(404).json({ error: 'Code not found' });
  res.json(db.voidCode(code.id));
});

app.get('/api/codes/:id/qr.png', async (req, res) => {
  const code = db.getCode(Number(req.params.id));
  if (!code) return res.status(404).send('Code not found');
  const png = await QRCode.toBuffer(redeemUrl(req, code.token), {
    type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M',
  });
  res.set('Content-Type', 'image/png');
  res.send(png);
});

// Printable sheet of all QR codes in a batch.
app.get('/admin-print/:batchId', requireAdmin, (req, res) => {
  const batch = db.getBatch(Number(req.params.batchId));
  if (!batch) return res.status(404).send('Batch not found');
  const cells = db.listCodes(batch.id).map((c) => `
    <div class="cell">
      <img src="/api/codes/${c.id}/qr.png" alt="QR code ${c.id}">
      <div class="who">${escapeHtml(c.recipient_name || `Code #${c.id}`)}</div>
    </div>`).join('');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
    <title>Print — ${escapeHtml(batch.label)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 20px; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
      .cell { text-align: center; break-inside: avoid; }
      .cell img { width: 100%; max-width: 220px; }
      .who { font-size: 14px; margin-top: 4px; }
      @media print { h1 { font-size: 16px; } }
    </style></head>
    <body><h1>${escapeHtml(batch.label)}</h1><div class="grid">${cells}</div>
    <script>window.print()</script></body></html>`);
});

// ---------- Public redemption ----------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function redemptionPage({ icon, title, message, benefit, button }) {
  return `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; display: flex; min-height: 100vh; margin: 0;
             align-items: center; justify-content: center; background: #f4f4f7; color: #1c1c28; }
      .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 420px; margin: 16px;
              text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
      .icon { font-size: 56px; }
      h1 { font-size: 22px; margin: 16px 0 8px; }
      p { color: #55556b; line-height: 1.5; margin: 0 0 8px; }
      .benefit { font-size: 18px; font-weight: 600; color: #1c1c28; margin: 16px 0; }
      button { font-size: 17px; font-weight: 600; color: #fff; background: #2563eb; border: 0;
               border-radius: 10px; padding: 14px 32px; margin-top: 16px; cursor: pointer; width: 100%; }
      button:active { background: #1d4ed8; }
    </style></head><body><div class="card">
      <div class="icon">${icon}</div>
      <h1>${escapeHtml(title)}</h1>
      ${benefit ? `<div class="benefit">${escapeHtml(benefit)}</div>` : ''}
      <p>${escapeHtml(message)}</p>
      ${button ? `<form method="POST"><button type="submit">${escapeHtml(button)}</button></form>` : ''}
    </div></body></html>`;
}

function statusPage(state, code) {
  switch (state) {
    case 'used':
      return redemptionPage({
        icon: '\u{1F6AB}', title: 'Already redeemed',
        message: `This code was redeemed on ${new Date(code.redeemed_at).toLocaleString()} and can only be used once.`,
      });
    case 'expired':
      return redemptionPage({
        icon: '\u{23F0}', title: 'Code expired',
        message: `This code expired on ${new Date(code.expires_at).toLocaleString()}.`,
      });
    case 'void':
      return redemptionPage({
        icon: '\u{1F6AB}', title: 'Code cancelled',
        message: 'This code is no longer valid.',
      });
    default:
      return redemptionPage({
        icon: '\u{2753}', title: 'Invalid code',
        message: 'This QR code was not recognized. Please check with the issuer.',
      });
  }
}

// Scanning shows the offer with a Redeem button. The code is only consumed by the
// POST below — so link previews / prefetchers in messaging apps can't burn it.
app.get('/r/:token', (req, res) => {
  const code = db.getCodeByToken(req.params.token);
  const state = db.codeState(code);
  if (state !== 'active') return res.status(state === 'invalid' ? 404 : 410).send(statusPage(state, code));
  res.send(redemptionPage({
    icon: '\u{1F381}', title: code.batch_label,
    benefit: code.benefit,
    message: 'Tap the button below to redeem. This can only be done once — do it at the counter / with staff present.',
    button: 'Redeem now',
  }));
});

app.post('/r/:token', (req, res) => {
  if (db.redeemCode(req.params.token)) {
    const code = db.getCodeByToken(req.params.token);
    return res.send(redemptionPage({
      icon: '\u{2705}', title: 'Redeemed!',
      benefit: code.benefit,
      message: `Redeemed on ${new Date(code.redeemed_at).toLocaleString()}. Show this screen to claim your benefit.`,
    }));
  }
  const code = db.getCodeByToken(req.params.token);
  const state = db.codeState(code);
  res.status(state === 'invalid' ? 404 : 410).send(statusPage(state, code));
});

app.listen(PORT, () => {
  console.log(`QRSRF running on http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) {
    console.warn('WARNING: ADMIN_PASSWORD is not set — the admin panel is unprotected. Set it before deploying.');
  }
});
