const express = require('express');
const router = express.Router();
const accountController = require('../controllers/AccountController');
// const requireAuth = require('../middleware/authMiddleware'); // Future addition

// Create account (CASH or BANK)
router.post('/create', /* requireAuth, */ accountController.createAccount);

// Get All Accounts (Dashboard View)
router.get('/balances/:userId', /* requireAuth, */ accountController.getAccountBalances);

module.exports = router;