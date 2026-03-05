const express = require('express');
const router = express.Router();
const protect = require('../middlewares/auth.middleware');
const transactionController = require('../controllers/transactionController');

router.use(protect);

router.get('/history', transactionController.getHistory);
router.post('/process', transactionController.processTransaction);

module.exports = router;