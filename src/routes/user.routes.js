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

// profile routes
router.get("/profile", getProfile);
router.patch("/profile", updateProfile);

// password routes
router.patch("/password", changePassword);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// logout
router.post("/logout", logoutUser);

// delete account — soft delete, schedules permanent deletion after 14 days
router.delete("/account", deleteAccount);

module.exports = router;