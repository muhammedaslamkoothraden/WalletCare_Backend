const express = require("express");
const router = express.Router();

const accountController = require("../controllers/AccountController");
const protect = require("../middlewares/auth.middleware");

// Protect all account routes
router.use(protect);

router.post("/create", accountController.createAccount);
router.get("/balances", accountController.getAccountBalances);
router.put("/:accountId/primary", accountController.setAccountAsDefault);

module.exports = router;