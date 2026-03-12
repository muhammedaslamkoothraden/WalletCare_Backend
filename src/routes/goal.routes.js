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
  getGoalPrediction,
  getAccountGoalTransitions // The new history function
} = require("../controllers/goal.controller");

// --- 1. Static & Summary Routes ---
// Always keep these above /:id routes
router.get("/summary", authMiddleware, getGoalSummary);
router.get("/analytics/prediction", authMiddleware, getGoalPrediction);

// --- 2. History Routes ---
// Gets only ALLOCATIONS and DEALLOCATIONS for a specific account
router.get("/account/:accountId/history", authMiddleware, getAccountGoalTransitions);

// --- 3. Collection Routes ---
router.get("/", authMiddleware, goalLimiter, getGoals);
router.post("/", authMiddleware, goalLimiter, createGoal);

// --- 4. Individual ID-based Routes ---
// Added missing authMiddleware to deposit
router.post("/:id/deposit", authMiddleware, goalLimiter, depositToGoal);
router.post("/:id/withdraw", authMiddleware, goalLimiter, withdrawFromGoal);

router.put("/:id", authMiddleware, updateGoal);
router.delete("/:id", authMiddleware, deleteGoal);
router.get("/:id", authMiddleware, getGoals); // Get a specific goal by ID 

module.exports = router;