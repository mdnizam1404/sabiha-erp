> **v5.1:** Platform Owner (super admin) console and company sign-up are documented in PLATFORM_OWNER_GUIDE_v5.1.md

# SABIHA ERP v14 Multi-Company Install

This build keeps the v13 PostgreSQL/synchronous route architecture but adds a platform registry and one PostgreSQL database per company.

## Requirements

- PostgreSQL 13+ (14–17 recommended)
- Node.js 18+
- A PostgreSQL login with permission to create databases (`CREATEDB`) for automatic provisioning

## First installation

1. Copy the package to the server/PC.
2. Copy `.env.example` to `.env`.
3. Set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`.
4. Leave `PGDATABASE=sabiha_default` for the initial/default company database.
5. Set a strong random `JWT_SECRET` and `PLATFORM_ADMIN_KEY`.
6. Set `DEFAULT_COMPANY_CODE` and `DEFAULT_COMPANY_NAME` for the first company.
7. Run `npm install`.
8. Run `npm start`.

On first start:

- `sabiha_default` is created and initialized with the ERP schema.
- `sabiha_platform` is created and stores the company registry.
- The default company is registered automatically.
- Default login remains `ADMIN` / `admin` unless changed.

Change the default ADMIN password immediately after installation.

## Create another company

From the server directory:

```bash
node provision-company.js --code ABC001 --name "ABC Manufacturing Pvt Ltd" --admin-user ADMIN --admin-password "StrongPasswordHere" --branch "Head Office"
```

List companies:

```bash
npm run companies
```

The command automatically creates a separate database such as `sabiha_abc001_xxxxxxxx`, initializes the complete ERP schema, creates the first branch, and sets the supplied company Administrator credentials.

The browser login now requires **Company Code + Username + Password**.

## Platform API

For automation, the server exposes:

- `POST /api/platform/companies`
- `GET /api/platform/companies`
- `PATCH /api/platform/companies/:code/status`

Send the platform key in `X-Platform-Key`. Never expose this key in the frontend or mobile application.

Example JSON for provisioning:

```json
{
  "companyCode": "ABC001",
  "companyName": "ABC Manufacturing Pvt Ltd",
  "adminUsername": "ADMIN",
  "adminPassword": "StrongPasswordHere",
  "branchName": "Head Office"
}
```

## Isolation model

Each company has its own PostgreSQL database. The JWT contains the company identity. Every authenticated request resolves that company in the platform registry and runs the existing ERP queries against that company's database.

A client cannot choose another database through a request body, query parameter, or arbitrary HTTP header.

## Offline/mobile synchronization

The backend exposes:

- `POST /api/sync/register-device`
- `GET /api/sync/status`
- `POST /api/sync/push`
- `GET /api/sync/pull`
- `POST /api/sync/ack`
- `POST /api/sync/revoke-device/:device_id`

The current server sync implementation accepts offline `SALES_INVOICE` create events. Invoice numbers, totals, salesperson attribution and stock-out movements are generated/validated by the server. UUID client IDs and event IDs make retries idempotent.

Mobile clients must never write absolute stock quantities to the server. Stock remains authoritative in the tenant's PostgreSQL ledger.

## Production notes

- Put the Node server behind HTTPS/reverse proxy.
- Use a process manager/service wrapper (systemd, PM2, NSSM, Windows service, etc.).
- Use PostgreSQL backups + WAL/PITR; the application JSON backup is not a replacement for PostgreSQL disaster recovery.
- For 250+ active companies, use PgBouncer and monitor PostgreSQL `max_connections`.
- Keep `MAX_TENANT_CONNECTIONS` bounded; inactive tenant connections are closed from the Node cache.
- Test backup/restore and cross-company access with at least two companies before production rollout.
