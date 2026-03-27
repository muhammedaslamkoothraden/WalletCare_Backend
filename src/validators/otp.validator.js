const { body } = require("express-validator");

const VALID_PURPOSES = ["signup", "reset_password"];

// POST /otp/resend — public
exports.validateResendOtp = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required").bail()
    .isEmail().withMessage("Invalid email address").bail()
    .normalizeEmail(),

  body("purpose")
    .trim()
    .notEmpty().withMessage("Purpose is required").bail()
    .isIn(VALID_PURPOSES).withMessage("Invalid purpose")
];

// POST /otp/verify — public
exports.validateVerifyOtp = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required").bail()
    .isEmail().withMessage("Invalid email address").bail()
    .normalizeEmail(),

  body("otp")
    .trim()
    .notEmpty().withMessage("OTP is required").bail()
    .isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits").bail()
    .isNumeric().withMessage("OTP must contain numbers only"),

  body("purpose")
    .trim()
    .notEmpty().withMessage("Purpose is required").bail()
    .isIn(VALID_PURPOSES).withMessage("Invalid purpose")
];

// POST /otp/resend/private — protected (email from token)
exports.validateResendOtpPrivate = [
  body("purpose")
    .trim()
    .notEmpty().withMessage("Purpose is required").bail()
    .isIn(VALID_PURPOSES).withMessage("Invalid purpose")
];

// POST /otp/verify/private — protected (email from token)
exports.validateVerifyOtpPrivate = [
  body("otp")
    .trim()
    .notEmpty().withMessage("OTP is required").bail()
    .isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits").bail()
    .isNumeric().withMessage("OTP must contain numbers only"),

  body("purpose")
    .trim()
    .notEmpty().withMessage("Purpose is required").bail()
    .isIn(VALID_PURPOSES).withMessage("Invalid purpose")
];