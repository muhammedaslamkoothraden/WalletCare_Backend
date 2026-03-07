const express = require("express");
const router = express.Router();

const { registerUser, loginUser, resendEmailOtp, refreshAccessToken } = require("../controllers/auth.controller");
const { verifyEmailOtp } = require("../controllers/verificationController");

router.post("/register", registerUser);
router.post("/verify-otp", verifyEmailOtp);
router.post("/resend-otp", resendEmailOtp);
router.post("/login", loginUser);
router.post("/refresh", refreshAccessToken);

module.exports = router;