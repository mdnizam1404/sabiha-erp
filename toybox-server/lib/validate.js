// ============================================================================
// lib/validate.js — centralized Zod validation middleware for SABIHA ERP.
// All critical write APIs should validate at the server boundary before any
// business logic or database mutation. Unknown fields are preserved so this
// remains backward-compatible with the existing frontend payloads.
// ============================================================================
const { z } = require('zod');

function validationError(result) {
  return result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) return res.status(400).json({ error: validationError(result), validation: true });
    req.body = result.data;
    next();
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params || {});
    if (!result.success) return res.status(400).json({ error: validationError(result), validation: true });
    req.params = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query || {});
    if (!result.success) return res.status(400).json({ error: validationError(result), validation: true });
    req.query = result.data;
    next();
  };
}

module.exports = { z, validateBody, validateParams, validateQuery, validationError };
