const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');

// ✅ UPDATED ROUTES
router.get('/history/:userId', transactionController.getHistory);

// This handles BOTH new transactions AND reversals now
router.post('/process', transactionController.processTransaction); 

module.exports = router;