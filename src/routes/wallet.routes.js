const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');

// Get wallet balances by userId
router.get('/:userId', walletController.getWalletByUserId);

module.exports = router;
