const express = require("express");
const router = express.Router();
const { generalLimiter } = require("../middlewares/rateLimit.middleware");

const {
  createGoal,
  getGoals,
  updateGoal,
  deleteGoal,
  getGoalSummary,
  depositToGoal,
  withdrawFromGoal,
  getGoalPrediction,
  getAccountGoalTransitions,
  getGoalById,
  shareGoal,
  getGoalHistory
} = require("../controllers/goal.controller");


// Static & summary routes — must be above /:id routes
router.get("/summary", getGoalSummary);
router.get("/analytics/prediction", getGoalPrediction);

// --- 2. History Routes ---
// Gets only ALLOCATIONS and DEALLOCATIONS for a specific account
router.get("/account/:accountId/history", getAccountGoalTransitions);
router.get("/:id/history", getGoalHistory); // Full history for a specific goal

// Collection routes
router.get("/", generalLimiter, getGoals);
router.post("/", generalLimiter, createGoal);

// Individual ID-based routes
router.get("/:id", getGoalById);
router.put("/:id", updateGoal);
router.delete("/:id", deleteGoal);
router.post("/:id/deposit", generalLimiter, depositToGoal);
router.post("/:id/withdraw", generalLimiter, withdrawFromGoal);
router.post("/:id/share", shareGoal);

module.exports = router;