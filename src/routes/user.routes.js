const express = require("express");
const router = express.Router();

const {
  getProfile,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  logoutUser,
  deleteAccount
} = require("../controllers/user.controller");

const validate = require("../middlewares/validate.middleware");
const {
  validateUpdateProfile,
  validateChangePassword,
  validateResetPassword,
  validateDeleteAccount
} = require("../validators/user.validator");

const { generalLimiter, strictLimiter } = require("../middlewares/rateLimit.middleware");

// profile routes
router.get("/profile", generalLimiter, getProfile);
router.patch("/profile", generalLimiter, validateUpdateProfile, validate, updateProfile);

// password routes
router.patch("/password", generalLimiter, validateChangePassword, validate, changePassword);
router.post("/forgot-password", strictLimiter, forgotPassword);
router.post("/reset-password", generalLimiter, validateResetPassword, validate, resetPassword);

// logout
router.post("/logout", generalLimiter, logoutUser);

// delete account — soft delete, schedules permanent deletion after 14 days
router.delete("/account", strictLimiter, validateDeleteAccount, validate, deleteAccount);

module.exports = router;