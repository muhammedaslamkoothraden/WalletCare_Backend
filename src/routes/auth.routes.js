const express = require("express");
const router = express.Router();

const {
  registerUser,
  loginUser,
  refreshAccessToken,
  forgotPassword,
  resetPassword
} = require("../controllers/auth.controller");

const { verifyEmailOtp } = require("../controllers/verification.controller");

const validate = require("../middlewares/validate.middleware");
const {
  validateRegister,
  validateVerifyEmail,
  validateLogin,
  validateForgotPassword,
  validateResetPassword
} = require("../validators/auth.validator");

const { generalLimiter, strictLimiter } = require("../middlewares/rateLimit.middleware");

// registration flow
router.post("/register", strictLimiter, validateRegister, validate, registerUser);
router.post("/verify-email", generalLimiter, validateVerifyEmail, validate, verifyEmailOtp);

// login
router.post("/login", strictLimiter, validateLogin, validate, loginUser);

// token management
router.post("/refresh", generalLimiter, refreshAccessToken);

// forgot password flow
// resend OTP  → POST /api/otp/resend  { email, purpose: "reset_password" }
// verify OTP  → POST /api/otp/verify  { email, otp, purpose: "reset_password" }
router.post("/forgot-password", strictLimiter, validateForgotPassword, validate, forgotPassword);
router.post("/reset-password", generalLimiter, validateResetPassword, validate, resetPassword);

module.exports = router;