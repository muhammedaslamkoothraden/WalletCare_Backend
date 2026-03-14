const express = require("express");
const router = express.Router();

const { resendOtpHandler, verifyOtpHandler, resendOtpPrivate, verifyOtpPrivate } = require("../controllers/otp.controller");
const protect = require("../middlewares/auth.middleware");

const validate = require("../middlewares/validate.middleware");
const {
  validateResendOtp,
  validateVerifyOtp,
  validateResendOtpPrivate,
  validateVerifyOtpPrivate
} = require("../validators/otp.validator");

const { generalLimiter } = require("../middlewares/rateLimit.middleware");

// public routes — login page (email from body)
router.post("/resend", generalLimiter, validateResendOtp, validate, resendOtpHandler);
router.post("/verify", generalLimiter, validateVerifyOtp, validate, verifyOtpHandler);

// protected routes — inside app (email from token)
router.post("/resend/private", generalLimiter, protect, validateResendOtpPrivate, validate, resendOtpPrivate);
router.post("/verify/private", generalLimiter, protect, validateVerifyOtpPrivate, validate, verifyOtpPrivate);

module.exports = router;