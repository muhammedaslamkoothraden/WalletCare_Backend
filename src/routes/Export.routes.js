'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  WalletCare — Export Routes
 *  File: src/routes/export.routes.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express        = require('express');
const router         = express.Router();
const exportCtrl     = require('../controllers/export.controller');

/**
 * GET /api/export/pdf
 *
 * Query params (all optional):
 *   startDate  — ISO date string  e.g. "2025-01-01"
 *   endDate    — ISO date string  e.g. "2025-12-31"
 *   accountId  — ObjectId string  (filters transactions to one account)
 *
 * Returns:
 *   application/pdf — streams the PDF directly
 *
 * Flutter usage:
 *   final response = await http.get(
 *     Uri.parse('$baseUrl/api/export/pdf?startDate=2025-01-01'),
 *     headers: {'Authorization': 'Bearer $accessToken'},
 *   );
 *   // Save response.bodyBytes to device storage
 */
router.get('/pdf', exportCtrl.exportPDF);

module.exports = router;