'use strict';

const express = require('express');
const router = express.Router();
const accountController = require('../controllers/AccountController');

router.post('/create', accountController.createAccount);
router.get('/balances', accountController.getAccountBalances);

// Fix #9: PUT /:accountId/primary MUST come before PUT /:accountId
// to prevent Express matching "primary" as the accountId param
router.patch('/:accountId/default', accountController.setAccountAsDefault);
router.put('/:accountId', accountController.updateAccount);          // ← was missing

router.delete('/:accountId', accountController.deleteAccount);

module.exports = router;