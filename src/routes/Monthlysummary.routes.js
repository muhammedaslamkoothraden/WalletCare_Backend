'use strict';

/**
 * monthlySummary.routes.js
 *
 * Routes:
 *   GET  /api/summary/monthly            → authenticated user's summary + notification
 *   POST /api/summary/monthly/trigger    → admin-only batch trigger
 */

const express = require('express');
const router = express.Router();

const protect = require('../middlewares/auth.middleware');
const { adminMiddleware } = require('../middlewares/admin.middleware');
const {
  getMyMonthlySummary,
  triggerMonthlySummaryBatch,
} = require('../controllers/monthlySummary.controller');

// User endpoint — requires valid JWT
router.get('/monthly', protect, getMyMonthlySummary);

// Admin endpoint — adminMiddleware already verifies JWT + role in one step
router.post('/monthly/trigger', adminMiddleware, triggerMonthlySummaryBatch);

module.exports = router;