const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/auth");
const { getGoalSummary } = require("../controllers/goal.controller");


const {
  createGoal,
  getGoals,
  updateGoal,
  deleteGoal
} = require("../controllers/goal.controller");


// Protect all routes
router.post("/", authMiddleware, createGoal);
router.get("/", authMiddleware, getGoals);
router.put("/:id", authMiddleware, updateGoal);
router.get("/summary", authMiddleware, getGoalSummary);
router.delete("/:id", authMiddleware, deleteGoal);


module.exports = router;

