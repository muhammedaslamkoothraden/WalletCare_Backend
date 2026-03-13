const express = require("express");
const router = express.Router();

const {
  registerUser,
  loginUser,
  refreshAccessToken,
  forgotPassword,
  resetPassword
} = require("../controllers/auth.controller");

const { verifyEmailOtp } = require("../controllers/verificationController");

// registration flow
router.post("/register", registerUser);
router.post("/verify-email", verifyEmailOtp);   // renamed from /verify-otp

// login
router.post("/login", loginUser);

// token management
router.post("/refresh", refreshAccessToken);

// forgot password flow
// resend OTP  → POST /api/otp/resend  { email, purpose: "reset_password" }
// verify OTP  → POST /api/otp/verify  { email, otp, purpose: "reset_password" }
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

module.exports = router;