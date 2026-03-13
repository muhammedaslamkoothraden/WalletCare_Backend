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

// profile routes
router.get("/profile", getProfile);
router.patch("/profile", validateUpdateProfile, validate, updateProfile);

// password routes
router.patch("/password", validateChangePassword, validate, changePassword);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", validateResetPassword, validate, resetPassword);

// logout
router.post("/logout", logoutUser);

// delete account — soft delete, schedules permanent deletion after 14 days
router.delete("/account", validateDeleteAccount, validate, deleteAccount);

module.exports = router;