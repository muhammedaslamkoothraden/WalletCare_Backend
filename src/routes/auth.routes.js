const express = require("express");
const router = express.Router();

const { registerUser, loginUser } = require("../controllers/auth.controller");
const { verifyEmailOtp, resendEmailOtp } = require("../controllers/verificationController");

router.post("/register", registerUser);
router.post("/verify-otp", verifyEmailOtp);
router.post("/resend-otp", resendEmailOtp);
router.post("/login", loginUser);

module.exports = router;