'use strict';

const express = require('express');
const router  = express.Router();

const authMiddleware        = require('../middlewares/auth');
const transactionController = require('../controllers/transactionController');

router.get ('/history/:userId',          authMiddleware, transactionController.getHistory);
router.post('/process',          authMiddleware, transactionController.processTransaction);
router.post('/account-transfer', authMiddleware, transactionController.accountTransfer);

module.exports = router;