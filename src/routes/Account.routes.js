const express = require('express');
const router = express.Router();
const protect = require('../middlewares/auth.middleware');
const accountController = require('../controllers/AccountController');

// Protect all account routes
router.use(protect);

// Create account (CASH or BANK)
router.post('/create', accountController.createAccount);

// 1. Get All Accounts (Dashboard View) and add accountId for specific account details
router.get('/balances', accountController.getAccountBalances);

module.exports = router;