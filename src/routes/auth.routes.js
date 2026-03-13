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

const validate = require("../middlewares/validate.middleware");
const {
  validateRegister,
  validateVerifyEmail,
  validateLogin,
  validateForgotPassword,
  validateResetPassword
} = require("../validators/auth.validator");

// registration flow
router.post("/register", validateRegister, validate, registerUser);
router.post("/verify-email", validateVerifyEmail, validate, verifyEmailOtp);

// login
router.post("/login", validateLogin, validate, loginUser);

// token management
router.post("/refresh", refreshAccessToken);

// forgot password flow
// resend OTP  → POST /api/otp/resend  { email, purpose: "reset_password" }
// verify OTP  → POST /api/otp/verify  { email, otp, purpose: "reset_password" }
router.post("/forgot-password", validateForgotPassword, validate, forgotPassword);
router.post("/reset-password", validateResetPassword, validate, resetPassword);

module.exports = router;