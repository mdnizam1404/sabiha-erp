# SABIHA ERP — WhatsApp PDF Attachment Update v9

## What changed

- Sales Invoice → Send Invoice PDF via WhatsApp now uses the WhatsApp Business Cloud API and sends the actual generated PDF document.
- Payroll → Send Payslip PDF via WhatsApp now uses the same API and sends the actual generated payslip PDF.
- The server generates the same PDF used by the normal PDF download route, so the attachment is not a screenshot or a text-only message.
- Added Settings → Bank, UPI & Email → WhatsApp Business Cloud API configuration.
- Added Test Connection button for administrators.
- WhatsApp API credentials are stored in the server `.env` file, not in SQLite database backups.
- Added `lib/whatsapp.js` using Node 18+ built-in `fetch`, `FormData`, and `Blob`; no new npm package is required.
- If the WhatsApp Cloud API is not configured, the PDF send button reports the exact configuration error instead of falsely opening a text-only WhatsApp chat.
- Existing wa.me text-based reminder/statement flows remain unchanged.

## Required configuration

In SABIHA ERP, sign in as Administrator and open:

Settings → Bank, UPI & Email → WhatsApp Business Cloud API — PDF Attachments

Enter:

1. WhatsApp Phone Number ID
2. Meta WhatsApp Cloud API Access Token
3. Graph API Version (for example `v23.0`; use the version supported by your Meta app)

Click Save, then Test Connection.

## Important Meta limitation

A `wa.me` browser URL cannot programmatically attach a local PDF. The new automatic attachment feature therefore uses the WhatsApp Business Cloud API. Meta may require an approved message template when a business-initiated message is sent outside the customer's allowed service/conversation window.

## Runtime test

- `node --check` passed for `routes/admin.js`, `lib/whatsapp.js`, and `public/app.js`.
- A mocked Cloud API integration test passed: the sender uploaded a PDF as multipart FormData and then sent a WhatsApp document message using the returned media ID.
- A real Meta send was not performed because this development environment does not have the user's WhatsApp Cloud API credentials.
