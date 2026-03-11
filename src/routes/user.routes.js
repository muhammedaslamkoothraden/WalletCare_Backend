const express = require("express");
const router = express.Router();

const { getProfile, updateProfile, changePassword, logoutUser } = require("../controllers/user.controller");
const protect = require("../middlewares/auth.middleware");

// profile routes
router.get("/profile", protect, getProfile);
router.patch("/profile", updateProfile);
router.patch("/password", changePassword);

// logout
router.post("/logout", logoutUser);


module.exports = router;