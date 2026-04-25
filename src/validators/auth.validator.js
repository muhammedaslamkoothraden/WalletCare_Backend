const { body } = require("express-validator");

// POST /auth/register
exports.validateRegister = [
  body("name")
    .trim()
    .notEmpty().withMessage("Name is required").bail()
    .isLength({ min: 2, max: 50 }).withMessage("Name must be between 2 and 50 characters").bail()
    .matches(/^[a-zA-Z\s]+$/).withMessage("Name must contain letters only"),

  body("email")
    .trim()
    .notEmpty().withMessage("Email is required").bail()
    .isEmail().withMessage("Invalid email address").bail()
    .normalizeEmail(),

  body("password") 
    .notEmpty().withMessage("Password is required").bail()
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters").bail()
    .not().matches(/[\u{1F000}-\u{1FFFF}]/u).withMessage("Password must not contain emojis")
];

// POST /auth/verify-email
exports.validateVerifyEmail = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required").bail()
    .isEmail().withMessage("Invalid email address").bail()
    .normalizeEmail(),

  body("otp")
    .trim()
    .notEmpty().withMessage("OTP is required").bail()
    .isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits").bail()
    .isNumeric().withMessage("OTP must contain numbers only")
];

// POST /auth/login
exports.validateLogin = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required").bail()
    .isEmail().withMessage("Invalid email address").bail()
    .normalizeEmail(),

  body("password")
    .notEmpty().withMessage("Password is required")
];

// POST /auth/forgot-password
exports.validateForgotPassword = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required").bail()
    .isEmail().withMessage("Invalid email address").bail()
    .normalizeEmail()
];

// POST /auth/reset-password
exports.validateResetPassword = [
  body("resetToken")
    .notEmpty().withMessage("Reset token is required"),

  body("newPassword")
    .notEmpty().withMessage("New password is required").bail()
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters").bail()
    .not().matches(/[\u{1F000}-\u{1FFFF}]/u).withMessage("Password must not contain emojis")
];