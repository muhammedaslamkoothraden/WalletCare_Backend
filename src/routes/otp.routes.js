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

// public routes — login page (email from body)
router.post("/resend", validateResendOtp, validate, resendOtpHandler);
router.post("/verify", validateVerifyOtp, validate, verifyOtpHandler);

// protected routes — inside app (email from token)
router.post("/resend/private", protect, validateResendOtpPrivate, validate, resendOtpPrivate);
router.post("/verify/private", protect, validateVerifyOtpPrivate, validate, verifyOtpPrivate);

module.exports = router;