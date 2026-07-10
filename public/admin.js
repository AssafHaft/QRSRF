let selectedBatchId = null;

const $ = (sel) => document.querySelector(sel);

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// ---------- Batches ----------

async function loadBatches() {
  const batches = await api('/api/batches');
  const list = $('#batch-list');
  list.innerHTML = '';
  if (batches.length === 0) {
    list.innerHTML = '<p class="hint">No batches yet — create one on the left.</p>';
    return;
  }
  for (const b of batches) {
    const item = document.createElement('div');
    item.className = 'batch-item' + (b.id === selectedBatchId ? ' selected' : '');
    item.innerHTML = `
      <div>
        <div class="name"></div>
        <div class="meta">${b.used}/${b.total} redeemed${b.expired ? ` · ${b.expired} expired` : ''}${b.voided ? ` · ${b.voided} void` : ''} · created ${fmtDate(b.created_at)}</div>
      </div>`;
    item.querySelector('.name').textContent = b.label;
    item.addEventListener('click', () => selectBatch(b.id, b.label));
    list.appendChild(item);
  }
}

async function selectBatch(id, label) {
  selectedBatchId = id;
  $('#codes-panel').hidden = false;
  $('#codes-title').textContent = label;
  $('#csv-link').href = `/api/batches/${id}/export.csv`;
  $('#print-link').href = `/admin-print/${id}`;
  await Promise.all([loadCodes(id), loadBatches()]);
}

// ---------- Codes ----------

async function loadCodes(batchId) {
  const { batch, codes } = await api(`/api/batches/${batchId}/codes`);
  $('#codes-title').textContent = batch.label;
  const tbody = $('#codes-table tbody');
  tbody.innerHTML = '';
  for (const c of codes) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.id}</td>
      <td><img class="qr-thumb" src="/api/codes/${c.id}/qr.png" alt="QR"></td>
      <td><input data-field="name" placeholder="Name"></td>
      <td><input data-field="contact" placeholder="Email / phone"></td>
      <td><span class="chip ${c.state}">${c.state}</span></td>
      <td>${c.sent_at ? fmtDate(c.sent_at) : `<button class="small secondary" data-act="sent">Mark sent</button>`}</td>
      <td>${fmtDate(c.redeemed_at)}</td>
      <td>
        <button class="small secondary" data-act="copy">Copy link</button>
        ${c.state === 'active' ? '<button class="small secondary" data-act="void">Void</button>' : ''}
      </td>`;

    const nameInput = tr.querySelector('[data-field="name"]');
    const contactInput = tr.querySelector('[data-field="contact"]');
    nameInput.value = c.recipient_name;
    contactInput.value = c.recipient_contact;
    const saveRecipient = () =>
      api(`/api/codes/${c.id}/recipient`, {
        method: 'PUT',
        body: JSON.stringify({ name: nameInput.value, contact: contactInput.value }),
      }).catch((e) => alert(e.message));
    nameInput.addEventListener('change', saveRecipient);
    contactInput.addEventListener('change', saveRecipient);

    tr.querySelector('.qr-thumb').addEventListener('click', () => showQr(c));
    tr.querySelector('[data-act="copy"]').addEventListener('click', () => copyLink(c.link));
    tr.querySelector('[data-act="sent"]')?.addEventListener('click', async () => {
      await api(`/api/codes/${c.id}/sent`, { method: 'POST', body: '{}' });
      loadCodes(batchId);
    });
    tr.querySelector('[data-act="void"]')?.addEventListener('click', async () => {
      if (!confirm(`Void code #${c.id}? It can no longer be redeemed.`)) return;
      await api(`/api/codes/${c.id}/void`, { method: 'POST', body: '{}' });
      selectBatch(batchId, $('#codes-title').textContent);
    });
    tbody.appendChild(tr);
  }
}

async function copyLink(link) {
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    prompt('Copy this link:', link);
  }
}

// ---------- QR modal ----------

function showQr(code) {
  $('#qr-img').src = `/api/codes/${code.id}/qr.png`;
  $('#qr-caption').textContent = code.link;
  $('#qr-download').href = `/api/codes/${code.id}/qr.png`;
  $('#qr-download').download = `qr-code-${code.id}.png`;
  $('#qr-copy').onclick = () => copyLink(code.link);
  $('#qr-modal').hidden = false;
}

$('#qr-close').addEventListener('click', () => ($('#qr-modal').hidden = true));
$('#qr-modal').addEventListener('click', (e) => {
  if (e.target === $('#qr-modal')) $('#qr-modal').hidden = true;
});

// ---------- Create form ----------

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const errorEl = $('#create-error');
  errorEl.hidden = true;

  const recipients = form.recipients.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(',');
      return { name: name.trim(), contact: rest.join(',').trim() };
    });

  try {
    const batch = await api('/api/batches', {
      method: 'POST',
      body: JSON.stringify({
        label: form.label.value,
        benefit: form.benefit.value,
        count: form.count.value ? Number(form.count.value) : 0,
        expiresAt: form.expiresAt.value ? new Date(form.expiresAt.value).toISOString() : null,
        recipients,
      }),
    });
    form.reset();
    await selectBatch(batch.id, batch.label);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

loadBatches();
