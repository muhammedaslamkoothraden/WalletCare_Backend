'use strict';

const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');

router.get('/history',                        transactionController.getHistory);
router.post('/process',                       transactionController.processTransaction);
router.post('/account-transfer',              transactionController.accountTransfer);
router.patch('/:transactionId/void',          transactionController.voidTransaction);

module.exports = router;