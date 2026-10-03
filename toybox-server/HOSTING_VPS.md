# Putting SABIHA ERP on a live server (Hostinger VPS)

**Important:** Hostinger's normal "web hosting" / "shared hosting" plans cannot run this package — it needs
Node.js **and** PostgreSQL running all the time. Use a **Hostinger VPS** (KVM 1 or KVM 2 is enough for
a small business) with **Ubuntu 22.04/24.04**. The apps (desktop and mobile) also need **HTTPS**, so you need a
domain name (for example `erp.yourcompany.com`) pointing to the VPS.

## 1. Prepare the VPS (once)
```bash
ssh root@YOUR_VPS_IP
apt update && apt install -y nginx postgresql git unzip curl ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm i -g pm2
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```
Create the database user:
```bash
sudo -u postgres psql -c "CREATE USER sabiha WITH PASSWORD 'CHOOSE_A_LONG_PASSWORD' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE sabiha_default OWNER sabiha;"
```
(`CREATEDB` is required: every company gets its own database.)

## 2. Upload and configure
Upload the `toybox-server` folder to `/opt/sabiha` (SFTP or `scp`), then:
```bash
cd /opt/sabiha && npm install --omit=dev && cp .env.example .env && nano .env
```
Set at least: `PORT=3000`, `JWT_SECRET` (a long random text — never change it later),
`PGUSER=sabiha`, `PGPASSWORD=…`, `PGDATABASE=sabiha_default`, `TRUST_PROXY=1`,
`SUPERADMIN_PASSWORD=…`. Then start it and keep it running after reboots:
```bash
pm2 start server.js --name sabiha && pm2 save && pm2 startup
```
The first start prints the Super Admin password (also in `data/SUPERADMIN_FIRST_PASSWORD.txt`).

## 3. HTTPS with nginx
`/etc/nginx/sites-available/sabiha`:
```nginx
server {
  server_name erp.yourcompany.com;
  client_max_body_size 20m;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host;
               proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }
}
```
```bash
ln -s /etc/nginx/sites-available/sabiha /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx && certbot --nginx -d erp.yourcompany.com
```
Open `https://erp.yourcompany.com` — the login page; `https://erp.yourcompany.com/platform.html` — Platform Owner console.

## 4. Backups that survive losing the server
The platform makes nightly company backups into `/opt/sabiha/data/company-backups/`. Copy that folder off
the VPS regularly (Hostinger's VPS snapshots, `rclone` to a cloud drive, or `scp` to your office PC), and also
enable the Hostinger weekly snapshot.

## 5. Updating later
Stop nothing — upload the new files over `/opt/sabiha`, run `npm install --omit=dev`, then `pm2 restart sabiha`.
Desktop apps pick up the new screens automatically; mobile apps keep working with the new server.
