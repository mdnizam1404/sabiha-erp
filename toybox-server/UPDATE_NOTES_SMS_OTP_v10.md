# SABIHA ERP — SMS OTP Login v10

## What changed
- Added SMS OTP as an optional second authentication step after a correct password.
- Added **Settings → SMS Gateway** admin page.
- Current provider integration: **MSG91 Flow API**.
- OTP: 6 digits, configurable expiry (default 5 minutes), resend wait (default 30 seconds), maximum 5 incorrect attempts.
- OTP/API credentials are stored in the server `.env` file, not SQLite.
- User mobile is taken from the User record first, then the linked Employee record.
- Added Send Test SMS button.

## Setup
1. Create/approve an MSG91 SMS template containing one variable matching the configured variable name (default `VAR1`).
2. In SABIHA ERP open **Administration/Settings → SMS Gateway**.
3. Enter MSG91 Auth Key, Template ID, country code, and save.
4. Enter a test mobile and click **Send Test SMS**.
5. Turn on **Require SMS OTP after correct password for every login**.

If SMS OTP is OFF, existing password login continues unchanged. If it is ON but the gateway is not configured or the user has no valid mobile number, login is blocked with a clear administrator message rather than silently bypassing OTP.

## API basis
MSG91's current documentation describes the Flow API as a POST to `https://control.msg91.com/api/v5/flow` using an `authkey`, `template_id`, and recipient mobile/variables.
