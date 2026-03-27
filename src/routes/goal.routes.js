const express = require("express");
const router = express.Router();

const protect = require("../middlewares/auth.middleware");
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

router.use(protect);

// --- 1. Static & Summary Routes (must be above /:id) ---
router.get("/summary", getGoalSummary);
router.get("/analytics/prediction", getGoalPrediction);

// --- 2. Account History Route (must be above /:id) ---
router.get("/account/:accountId/history", getAccountGoalTransitions);

// --- 3. Collection Routes ---
router.get("/", generalLimiter, getGoals);
router.post("/", generalLimiter, createGoal);

// --- 4. Individual ID-based Routes ---
router.get("/:id/history", getGoalHistory);
router.get("/:id", getGoalById);
router.put("/:id", updateGoal);
router.delete("/:id", deleteGoal);
router.post("/:id/deposit", generalLimiter, depositToGoal);
router.post("/:id/withdraw", generalLimiter, withdrawFromGoal);
router.post("/:id/share", shareGoal);

module.exports = router;