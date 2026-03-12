const express = require('express');
const router = express.Router();
const accountController = require('../controllers/AccountController');


const authMiddleware = require('../middlewares/auth'); 

router.post('/create', authMiddleware, accountController.createAccount);

router.get('/balances/:userId', authMiddleware, accountController.getAccountBalances);
// routes/accountRoutes.js
router.put('/:accountId/primary', authMiddleware, accountController.setAccountAsDefault );

module.exports = router;