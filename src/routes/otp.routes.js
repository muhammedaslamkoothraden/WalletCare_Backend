const express = require("express");
const router = express.Router();

const { resendOtpHandler, verifyOtpHandler, resendOtpPrivate, verifyOtpPrivate } = require("../controllers/otp.controller");
const protect = require("../middlewares/auth.middleware");

// public routes — login page (email from body)
router.post("/resend", resendOtpHandler);
router.post("/verify", verifyOtpHandler);

// protected routes — inside app (email from token)
router.post("/resend/private", protect, resendOtpPrivate);
router.post("/verify/private", protect, verifyOtpPrivate);

module.exports = router;