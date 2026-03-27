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
} = require("../controllers/goal.controller");

router.use(protect);

// Static & summary routes — must be above /:id routes
router.get("/summary", getGoalSummary);
router.get("/analytics/prediction", getGoalPrediction);

// History routes
router.get("/account/:accountId/history", getAccountGoalTransitions);

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