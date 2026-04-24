const express = require("express");
const router = express.Router();
const { adminMiddleware, requireSuperAdmin } = require("../middlewares/admin.middleware");
const adminController = require("../controllers/admin.controller");

// All routes below are protected — admin only
router.use(adminMiddleware);

// Stats
router.get("/stats", adminController.getStats);

// Heartbeat — updates lastActiveAt for the logged-in user/admin
router.patch("/heartbeat", adminController.heartbeat);

// Admin own profile & account management
router.get("/profile", adminController.getAdminProfile);
router.patch("/profile", adminController.updateAdminProfile);
router.patch("/change-password", adminController.changeAdminPassword);
router.post("/logout-all", adminController.logoutAllAdminSessions);

// Users
router.get("/users/scheduled-deletion", adminController.getScheduledDeletionUsers);
router.get("/users", adminController.getAllUsers);
router.get("/users/:id", adminController.getUserById);
router.patch("/users/:id/ban", adminController.banUser);
router.patch("/users/:id/unban", adminController.unbanUser);
router.post("/users/:id/logout", adminController.logoutUser);
router.patch("/users/:id/restore", adminController.restoreUser);

// User overview
router.get("/users/:id/overview", adminController.getUserOverview);

// Analytics
router.get("/analytics/users", adminController.getUserAnalytics);
router.get("/analytics/feedback", adminController.getFeedbackAnalytics);
router.get("/analytics/transactions", adminController.getTransactionAnalytics);
router.get("/analytics/goals", adminController.getGoalAnalytics);
router.get("/analytics/accounts", adminController.getAccountAnalytics);

// Feedback
router.get("/feedback", adminController.getAllFeedback);
router.get("/feedback/:id", adminController.getFeedbackById);
router.delete("/feedback/:id", adminController.deleteFeedback);

// ========== SUPERADMIN ONLY ROUTES ==========
router.post("/create-admin", requireSuperAdmin, adminController.createAdmin);
router.get("/admins", requireSuperAdmin, adminController.getAllAdmins);
router.patch("/demote/:id", requireSuperAdmin, adminController.demoteAdmin);
router.delete("/delete-admin/:id", requireSuperAdmin, adminController.deleteAdmin);

module.exports = router;