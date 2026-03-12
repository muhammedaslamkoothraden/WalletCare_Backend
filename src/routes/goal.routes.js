const express = require("express");
const goalLimiter = require("../middlewares/rateLimiter");
const router = express.Router();
const authMiddleware = require("../middlewares/auth");

const {
  createGoal,
  getGoals,
  updateGoal,
  deleteGoal,
  getGoalSummary,
  depositToGoal,   
  withdrawFromGoal,
  getGoalProgressAnalytics,
  getGoalCategoryStats,
  getMonthlyGoalSavings,
  getGoalPrediction,
  getGoalById
} = require("../controllers/goal.controller");


// Protect all routes
router.post("/", authMiddleware, goalLimiter, createGoal);
router.get("/", authMiddleware, goalLimiter, getGoals);
router.get("/summary", authMiddleware, getGoalSummary);
router.post("/:id/deposit", authMiddleware, depositToGoal);
router.post("/:id/withdraw", authMiddleware, withdrawFromGoal);
router.put("/:id", authMiddleware, updateGoal);
router.delete("/:id", authMiddleware, deleteGoal);
router.get("/analytics/prediction",authMiddleware,getGoalPrediction);
router.get("/:id", authMiddleware, getGoalById);

module.exports = router;