const express = require("express");
const router = express.Router();
const adminMiddleware = require("../middlewares/admin.middleware");
const adminController = require("../controllers/admin.controller");

// All routes below are protected — admin only
router.use(adminMiddleware);

// Stats
router.get("/stats", adminController.getStats);

// Users
router.get("/users", adminController.getAllUsers);
router.get("/users/:id", adminController.getUserById);
router.patch("/users/:id/ban", adminController.banUser);
router.patch("/users/:id/unban", adminController.unbanUser);
router.post("/users/:id/logout", adminController.logoutUser);
router.patch("/users/:id/restore", adminController.restoreUser);

// Analytics
router.get("/analytics", adminController.getAnalytics);

module.exports = router;