// ============================================================================
// lib/whatsapp.js — WhatsApp Business Cloud API document sender
// Sends a real PDF attachment (not just a wa.me text link).
// Node 18+ provides fetch, FormData and Blob natively.
// ============================================================================

function isConfigured() {
  return !!(
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

function config() {
  return {
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    graphVersion: String(process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0').trim(),
  };
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

async function graph(pathname, options = {}) {
  const c = config();
  if (!c.accessToken || !c.phoneNumberId) {
    throw new Error('WhatsApp Business Cloud API is not configured. Configure Phone Number ID and Access Token in Settings → Bank, UPI & Email → WhatsApp Business API.');
  }
  const url = `https://graph.facebook.com/${c.graphVersion}/${pathname.replace(/^\//, '')}`;
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${c.accessToken}` };
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  if (!response.ok) {
    const detail = body?.error?.message || body?.error?.error_user_msg || body?.raw || `HTTP ${response.status}`;
    throw new Error(`WhatsApp API error: ${detail}`);
  }
  return body;
}

async function uploadPdf(pdfBuffer, filename) {
  const c = config();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename);
  return graph(`${c.phoneNumberId}/media`, { method: 'POST', body: form });
}

async function sendPdf({ to, pdfBuffer, filename, caption }) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error('Recipient WhatsApp number is missing.');
  if (!isConfigured()) throw new Error('WhatsApp Business Cloud API is not configured. Configure Phone Number ID and Access Token in Settings → Bank, UPI & Email → WhatsApp Business API.');

  const media = await uploadPdf(pdfBuffer, filename);
  if (!media?.id) throw new Error('WhatsApp accepted the upload request but did not return a media ID.');

  const c = config();
  return graph(`${c.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'document',
      document: {
        id: media.id,
        caption: caption || '',
        filename,
      },
    }),
  });
}

async function testConnection() {
  const c = config();
  if (!isConfigured()) throw new Error('WhatsApp Business Cloud API is not configured.');
  return graph(`${c.phoneNumberId}?fields=display_phone_number,verified_name`);
}

module.exports = { isConfigured, config, normalizePhone, sendPdf, testConnection };
