const express = require("express");
const router = express.Router();
const accountController = require("../controllers/AccountController");

router.post("/create", accountController.createAccount);
router.get("/balances", accountController.getAccountBalances);
router.put("/:accountId/primary", accountController.setAccountAsDefault);
router.delete('/:accountId', accountController.deleteAccount);

module.exports = router;