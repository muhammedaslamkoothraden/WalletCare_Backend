'use strict';

const express = require('express');
const router = express.Router();

router.get('/history', transactionController.getHistory);
router.post('/process', transactionController.processTransaction);
router.post('/account-transfer', transactionController.accountTransfer);
router.post('/edit/:originalTxId', transactionController.editTransaction);

module.exports = router;