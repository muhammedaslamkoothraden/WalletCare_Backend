const { body } = require("express-validator");

// PATCH /user/profile
exports.validateUpdateProfile = [
  body("name")
    .trim()
    .notEmpty().withMessage("Name is required").bail()
    .isLength({ min: 2, max: 50 }).withMessage("Name must be between 2 and 50 characters").bail()
    .matches(/^[a-zA-Z\s]+$/).withMessage("Name must contain letters only")
];

// PATCH /user/password
exports.validateChangePassword = [
  body("currentPassword")
    .notEmpty().withMessage("Current password is required"),

  body("newPassword")
    .notEmpty().withMessage("New password is required").bail()
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters").bail()
    .not().matches(/[\u{1F000}-\u{1FFFF}]/u).withMessage("Password must not contain emojis")
];

// POST /user/reset-password
exports.validateResetPassword = [
  body("resetToken")
    .notEmpty().withMessage("Reset token is required"),

  body("newPassword")
    .notEmpty().withMessage("New password is required").bail()
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters").bail()
    .not().matches(/[\u{1F000}-\u{1FFFF}]/u).withMessage("Password must not contain emojis")
];

// DELETE /user/account
exports.validateDeleteAccount = [
  body("password")
    .notEmpty().withMessage("Password is required")
];