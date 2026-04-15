'use strict';

const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');

router.get('/history',                        transactionController.getHistory);
router.post('/process',                       transactionController.processTransaction);
router.post('/account-transfer',              transactionController.accountTransfer);
router.post('/reserve',                       transactionController.reserveFunds);
router.patch('/:transactionId/void',          transactionController.voidTransaction);
router.get('/latest',                         transactionController.getLatestTransactions);

module.exports = router;