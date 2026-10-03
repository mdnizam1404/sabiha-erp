#!/usr/bin/env node
const { provisionCompany, listCompanies } = require('./lib/multitenant');
function arg(name, fallback='') {
  const i=process.argv.indexOf('--'+name); return i>=0 ? String(process.argv[i+1]||fallback) : fallback;
}
if (process.argv.includes('--list')) { console.table(listCompanies()); process.exit(0); }
const companyCode=arg('code'), companyName=arg('name'), adminUsername=arg('admin-user','ADMIN'), adminPassword=arg('admin-password','admin'), branchName=arg('branch','Head Office');
if(!companyCode || !companyName){ console.error('Usage: node provision-company.js --code ABC001 --name "ABC Manufacturing" [--admin-user ADMIN] [--admin-password "StrongPassword"] [--branch "Head Office"]'); process.exit(2); }
try { const c=provisionCompany({companyCode,companyName,adminUsername,adminPassword,branchName}); console.log(JSON.stringify({company_code:c.company_code,company_name:c.company_name,database_name:c.database_name,status:c.status},null,2)); }
catch(e){ console.error('Provisioning failed:',e.message); process.exit(1); }
