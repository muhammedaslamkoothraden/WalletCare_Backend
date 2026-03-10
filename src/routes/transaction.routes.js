const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth'); 

const transactionController = require('../controllers/transactionController');

router.get('/history', authMiddleware, transactionController.getHistory);

router.post('/process', authMiddleware, transactionController.processTransaction); 

module.exports = router;