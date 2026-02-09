const express = require("express");
const router = express.Router();

// import controller functions
const {
  createGoal,
  getGoals,
} = require("../controllers/goal.controller");

// create routes
router.post("/", createGoal);
router.get("/", getGoals);

module.exports = router;
