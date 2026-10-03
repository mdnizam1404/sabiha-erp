// ============================================================================
// lib/schemas.js — shared request schemas.  These are deliberately additive
// and permissive (.passthrough()) so the existing SABIHA ERP payload shape is
// not redesigned while critical values are still validated server-side.
// ============================================================================
const { z } = require('./validate');

const id = z.coerce.number().int().positive();
const date = z.string().trim().min(1).max(30);
const money = z.coerce.number().finite().min(0);
const positiveMoney = z.coerce.number().finite().positive();
const qty = z.coerce.number().finite().positive();

const lineItemSchema = z.object({
  product_id: id,
  qty,
  rate: money,
  discount_pct: z.coerce.number().finite().min(0).max(100).default(0),
}).passthrough();

const loginSchema = z.object({
  company_code: z.string().trim().min(3).max(50).optional(),
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(500),
}).passthrough();

const futureOrderItemSchema = z.object({ product_id: id, qty }).passthrough();
const futureOrderSchema = z.object({
  expected_date: date,
  customer_id: id.nullish(),
  customer_name_freetext: z.string().trim().max(200).nullish(),
  probability_pct: z.coerce.number().finite().min(0).max(100).default(100),
  status: z.enum(['Open', 'Completed', 'Lost', 'Converted']).default('Open'),
  notes: z.string().max(2000).nullish(),
  items: z.array(futureOrderItemSchema).min(1),
}).passthrough();

const salesSchema = z.object({
  invoice_date: date,
  customer_id: id,
  due_date: date.nullish(),
  gst_pct: z.coerce.number().finite().min(0).max(100).default(18),
  gst_type: z.enum(['IGST', 'CGST_SGST']).default('CGST_SGST'),
  items: z.array(lineItemSchema).min(1),
  paid_now: money.default(0),
  paid_mode: z.string().trim().max(50).default('Cash'),
}).passthrough();

const receiptSchema = z.object({
  date,
  customer_id: id,
  invoice_id: id.nullish(),
  amount: positiveMoney,
  mode: z.string().trim().min(1).max(50).default('Cash'),
  reference_no: z.string().trim().max(100).default(''),
  remarks: z.string().max(1000).default(''),
}).passthrough();

const productBomSchema = z.object({ raw_material_id: id, qty_per_unit: qty, stage: z.string().max(100).nullish() }).passthrough();
const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(100).optional(),
  category: z.string().max(100).optional(),
  unit: z.string().trim().max(30).optional(),
  sale_rate: money.default(0),
  gst_rate: z.coerce.number().finite().min(0).max(100).default(18),
  hsn_code: z.string().trim().max(20).nullish(),
  min_stock: money.default(0),
  opening_stock: money.default(0),
  overhead_per_unit: money.default(0),
  barcode: z.string().trim().max(150).optional(),
  image_data_url: z.string().optional().nullable(),
  size: z.string().max(50).nullish(),
  weight: z.string().max(50).nullish(),
  color: z.string().max(50).nullish(),
  is_bundle: z.coerce.boolean().default(false),
  bundle_label: z.string().max(100).nullish(),
  bom: z.array(productBomSchema).optional(),
  bundle_components: z.array(z.object({ component_product_id: id, qty_per_bundle: qty }).passthrough()).optional(),
}).passthrough();

const productionSchema = z.object({
  batch_no: z.string().trim().max(100).default(''),
  date,
  product_id: id,
  shift: z.string().trim().max(50).default('Morning'),
  planned_qty: money.default(0),
  produced_qty: money.default(0),
  defective_qty: money.default(0),
  operator_id: id.nullish(),
  remarks: z.string().max(2000).default(''),
}).passthrough().refine((b) => b.produced_qty >= b.defective_qty, {
  message: 'Defective quantity cannot exceed produced quantity', path: ['defective_qty']
});

const incentiveRuleSchema = z.object({
  name: z.string().trim().min(1).max(150),
  trigger_type: z.enum(['SALES', 'PRODUCTION', 'BIDDING', 'RECOVERY', 'OVERTIME', 'JOB_TASK']),
  reward_type: z.enum(['FIXED', 'PERCENT']).default('FIXED'),
  reward_value: positiveMoney,
  active: z.boolean().default(true),
}).passthrough();

const taskSchema = z.object({
  employee_id: id,
  title: z.string().trim().min(1).max(200),
  assigned_date: date,
  due_date: date.nullish(),
  remarks: z.string().max(1000).nullish(),
}).passthrough();

const payrollSchema = z.object({
  employee_id: id,
  pay_month: z.string().trim().min(1).max(30),
  basic: money.default(0),
  hra: money.default(0),
  conveyance: money.default(0),
  other_allow: money.default(0),
  advance_deduction: money.default(0),
  pf: money.default(0),
  esi: money.default(0),
  other_deduction: money.default(0),
  paid_now: money.default(0),
  advance_id: id.nullish(),
}).passthrough();

const payrollPaymentSchema = z.object({
  amount: positiveMoney,
  date: date.optional(),
  mode: z.string().trim().max(50).default('Cash'),
  remarks: z.string().max(1000).default(''),
}).passthrough();

const userCreateSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(4).max(500),
  full_name: z.string().trim().max(200).optional(),
  role: z.string().trim().min(1).max(50),
  employee_id: id.nullish(),
  phone: z.string().trim().max(30).optional(),
}).passthrough();

const userStatusSchema = z.object({ status: z.enum(['Approved', 'Pending', 'Rejected']) }).passthrough();
const userEmployeeSchema = z.object({ employee_id: id.nullish() }).passthrough();
const userRoleSchema = z.object({ role: z.string().trim().min(1).max(50) }).passthrough();
const passwordResetSchema = z.object({ password: z.string().min(4).max(500) }).passthrough();


const attendanceSchema = z.object({
  work_date: date,
  employee_id: id,
  in_time: z.string().trim().max(20).default(''),
  out_time: z.string().trim().max(20).default(''),
  status: z.string().trim().max(30).default('Present'),
  remarks: z.string().max(1000).default(''),
}).passthrough();

const advanceSchema = z.object({
  employee_id: id,
  date,
  amount: positiveMoney,
  reason: z.string().max(1000).default(''),
}).passthrough();

const supplierPaymentSchema = z.object({
  date,
  supplier_id: id,
  purchase_id: id.nullish(),
  amount: positiveMoney,
  mode: z.string().trim().max(50).default('Cash'),
  reference_no: z.string().trim().max(100).default(''),
  remarks: z.string().max(1000).default(''),
}).passthrough();

const outsourcingPersonSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(30).default(''),
  email: z.string().trim().max(200).default(''),
  stage: z.string().trim().max(100).default('Molding'),
  default_rate: money.default(0),
  active: z.coerce.number().int().min(0).max(1).optional(),
}).passthrough();

const outsourcingJobSchema = z.object({
  date,
  person_id: id,
  product_id: id.nullish(),
  stage: z.string().trim().max(100).default('Molding'),
  qty_sent: money.default(0),
  qty_received: money.default(0),
  rate: money.default(0),
  status: z.string().trim().max(30).default('Pending'),
  remarks: z.string().max(1000).default(''),
}).passthrough();

const outsourcingPaymentSchema = z.object({
  date,
  person_id: id,
  job_id: id.nullish(),
  amount: positiveMoney,
  mode: z.string().trim().max(50).default('Cash'),
  reference_no: z.string().trim().max(100).default(''),
  remarks: z.string().max(1000).default(''),
}).passthrough();

module.exports = {
  id, date, money, positiveMoney, lineItemSchema, loginSchema, productSchema,
  futureOrderSchema, salesSchema, receiptSchema, productionSchema,
  incentiveRuleSchema, taskSchema, payrollSchema, payrollPaymentSchema, attendanceSchema, advanceSchema, supplierPaymentSchema, outsourcingPersonSchema, outsourcingJobSchema, outsourcingPaymentSchema,
  userCreateSchema, userStatusSchema, userEmployeeSchema, userRoleSchema,
  passwordResetSchema,
};
