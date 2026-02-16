// routes/dev.wallet.routes.js
const express = require('express');
const router = express.Router();
const { createWalletForUser } = require('../services/wallet.service');

router.post('/init-wallet', async (req, res) => {
  try {
    const { userId } = req.body;

    const wallet = await createWalletForUser(userId);

    res.status(200).json({
      message: 'Wallet initialized (dev only)',
      wallet
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
