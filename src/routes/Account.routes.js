const express = require('express');
const router = express.Router();
const accountController = require('../controllers/AccountController');


// Create account (CASH or BANK)
router.post('/create', accountController.createAccount);
// 1. Get All Accounts (Dashboard View) and add accontid for specific account details
router.get('/balances/:userId', accountController.getAccountBalances);



module.exports = router;
