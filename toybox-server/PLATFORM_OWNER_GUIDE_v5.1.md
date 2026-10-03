# SABIHA ERP v5.1 — Platform Owner (Super Admin) & company sign-up

## Who does what

| Role | Signs in at | Can do |
|---|---|---|
| **Platform Owner (super admin)** — you, the owner/developer | `http://localhost:3000/platform.html` | Create companies (Company ID + admin password), approve/reject company requests, monitor every company, suspend/re-activate, reset a company admin's password |
| **Company Admin** — one per company | main login page (Company ID + User ID + password) | Approve/reject that company's user requests, assign roles, manage everything inside that company |
| **Company users** | main login page | Work inside their own company only |

Companies are completely separate: each has its own private database. A company admin never sees another company's data, and the super-admin token can never be used as a company login (and vice versa).

## 1. First start — get your super-admin login
1. Run `start.bat`. In the black window you will see a box **"PLATFORM OWNER (SUPER ADMIN) ACCOUNT CREATED"** with a User ID and a one-time password (also saved in `data\SUPERADMIN_FIRST_PASSWORD.txt`).
   *(Prefer your own password? Put `SUPERADMIN_PASSWORD=YourPass123` in `.env` before the first start.)*
2. Open `http://localhost:3000/platform.html` (or click **Platform owner sign-in** on the normal login page).
3. Sign in — you are asked to set a new password straight away. Delete the `SUPERADMIN_FIRST_PASSWORD.txt` file afterwards.
4. Lost the password? On the server run: `node reset-superadmin-password.js NewPassword123`

## 2. Creating companies (two ways)

**A. You create it** — console → **Create Company**: enter company name, **Company ID** (used at sign-in), admin User ID and password. Give those three details to the company.

**B. The company asks for it** — on the login page a visitor clicks **Register Company**, fills the form (company name, preferred Company ID, contact, email, admin User ID and password) and gets a **reference number**. In your console **Company Requests** shows it (with a badge). Click **Approve…** (you can change the Company ID) — the company's private database is created immediately, with the admin login the applicant chose — or **Reject…** with a reason. The applicant checks the outcome on the login page with the reference number ("Already applied? Check your request status"). No email is sent; tell them, or they check the status.

## 3. Monitoring every company
* **Dashboard** — total companies, pending requests, total users, sales this month, storage, and one row per company: status, users (active / total, and how many are waiting for that company's admin), employees, customers, invoices, sales this month, last login, last activity, database size. Refreshes every minute.
* **View** on any company — full user list (role, status, last login) and its last 100 activity entries.
* **Companies** — Suspend (nobody in that company can sign in or continue working; data is kept) / Re-activate / **Reset admin password**.
* **Activity Log** — everything done at platform level (sign-ins, approvals, suspensions, password resets).
* Sign-in lock: 5 wrong passwords lock the super-admin account for 15 minutes.

## 4. How users join a company
1. On the login page the user opens **Create Account**, picks their **Company ID** (drop-down list of active companies, or types it — the company name is shown as confirmation), fills their details and verifies the email code.
2. The request goes only to **that company's** admin: it appears in **Users & Roles → "Awaiting your approval"**, with a badge on the menu and a notice when the admin signs in.
3. The company admin chooses the **role** and clicks **Approve** (or **Reject**). Until then the user cannot sign in. The role the person asked for is only a suggestion.

Want the company list hidden from the public? Set `PUBLIC_COMPANY_LIST=false` in `.env` — users then type their Company ID.

## 5. Settings (.env)
| Setting | Meaning |
|---|---|
| `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` | Owner login created on first start (blank password = generated) |
| `PLATFORM_ADMIN_KEY` | Optional key for scripts/automation (`X-Platform-Key` header) |
| `PUBLIC_COMPANY_LIST` | `true` shows the company selector list on the login page |
| `COMPANY_REQUEST_LIMIT_PER_HOUR` | Company requests allowed per device per hour (default 10) |
| `REGISTER_RATE_LIMIT_PER_HOUR` | User sign-up attempts per device per hour (default 30) |

## 6. Security notes
* Company-request passwords are stored only as hashes; the console never shows them.
* Deleting a company is intentionally not offered (irreversible) — suspend it instead. To remove one for good, drop its database in PostgreSQL and delete its row in `companies` (platform database).
* Run the app behind HTTPS if it is reachable from the internet.
