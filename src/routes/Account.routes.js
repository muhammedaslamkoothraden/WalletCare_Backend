const express = require('express');
const router = express.Router();
const accountController = require('../controllers/AccountController');


const authMiddleware = require('../middlewares/auth'); 

router.post('/create', authMiddleware, accountController.createAccount);

router.get('/balances', authMiddleware, accountController.getAccountBalances);

module.exports = router;