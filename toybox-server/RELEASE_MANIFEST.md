# SABIHA ERP Multi-Company Release 5.5.0 (see UPDATE_NOTES_v5.5.0.md, v5.4.0, v5.3.0 and v5.2.0)

(Original 5.0.0 notes follow.)

Base package: SABIHA_ERP_PostgreSQL_v13

This release adds:
- platform company registry in a separate PostgreSQL database
- one PostgreSQL database per company
- company-code-bound JWT authentication
- automatic company database provisioning
- branch/factory master and branch-bound users/employees/transactions
- mobile device registration/revocation
- offline sales invoice push/pull synchronization with idempotency
- tenant sync inbox/outbox and sequence tracking
- bounded tenant connection cache
- Windows/Linux provisioning helpers

Important: this package is source/installable software, not a prebuilt Windows .exe. Run `install.bat`/`install.sh`, then `start.bat`/`start.sh`.
