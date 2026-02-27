const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth");

const {
  createGoal,
  getGoals,
  updateGoal,
  deleteGoal,
  getGoalSummary,
  depositToGoal,   
  withdrawFromGoal
} = require("../controllers/goal.controller");

// Protect all routes
router.post("/", authMiddleware, createGoal);
router.get("/", authMiddleware, getGoals);
router.get("/summary", authMiddleware, getGoalSummary);
router.post("/:id/deposit", authMiddleware, depositToGoal);
router.post("/:id/withdraw", authMiddleware, withdrawFromGoal);
router.put("/:id", authMiddleware, updateGoal);
router.delete("/:id", authMiddleware, deleteGoal);

module.exports = router;