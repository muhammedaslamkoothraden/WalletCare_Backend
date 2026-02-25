const express = require("express");
const router = express.Router();
const { verifyEmailOtp } = require("../controllers/verificationController");


const { registerUser, loginUser } = require("../controllers/auth.controller");

router.post("/register", registerUser);
router.post("/verify-otp", verifyEmailOtp);
router.post("/login", loginUser);

module.exports = router;
