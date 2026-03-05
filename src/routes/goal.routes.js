const express = require("express");
const router = express.Router();

const protect = require("../middlewares/auth.middleware");

const {
  createGoal,
  getGoals,
  updateGoal,
  deleteGoal,
  getGoalSummary
} = require("../controllers/goal.controller");

router.use(protect);

router.post("/", createGoal);
router.get("/", getGoals);
router.put("/:id", updateGoal);
router.get("/summary", getGoalSummary);
router.delete("/:id", deleteGoal);

module.exports = router;