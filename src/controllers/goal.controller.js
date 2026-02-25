const Goal = require("../models/Goal");
const {
  calculateGoalDetails,
  calculateSummary
} = require("../services/goal.service");
const Wallet = require("../models/wallet");
const { processGoalDeposit } = require("../services/goal.service");


// CREATE GOAL
exports.createGoal = async (req, res) => {
  try {
    const { title, category, targetAmount, targetDate, accountType } = req.body;

    if (!title || !category || !targetAmount || !targetDate || !accountType) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }

    if (targetAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Target amount must be positive"
      });
    }

    const goal = await Goal.create({
      userId: req.user.id,
      title,
      category,
      targetAmount,
      accountType,
      targetDate
    });

    res.status(201).json({
      success: true,
      message: "Goal created successfully",
      data: goal
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};



// GET ALL GOALS
exports.getGoals = async (req, res) => {
  try {

    const goals = await Goal.find({
      userId: req.user.id
    });

    const goalsWithDetails = calculateGoalDetails(goals);

    res.status(200).json({
      success: true,
      data: goalsWithDetails
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};



// UPDATE GOAL
exports.updateGoal = async (req, res) => {
  try {

    const goal = await Goal.findById(req.params.id);

    if (!goal) {
      return res.status(404).json({
        success: false,
        message: "Goal not found"
      });
    }

    if (goal.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized"
      });
    }

    if (goal.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "Cannot modify completed goal"
      });
    }

    if (req.body.status) {
      return res.status(400).json({
        success: false,
        message: "Status cannot be updated manually"
      });
    }

    if (req.body.targetAmount && req.body.targetAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Target amount must be positive"
      });
    }

    if (req.body.title) goal.title = req.body.title;
    if (req.body.category) goal.category = req.body.category;
    if (req.body.targetAmount) goal.targetAmount = req.body.targetAmount;
    if (req.body.targetDate) goal.targetDate = req.body.targetDate;
    if (req.body.currentAmount >= 0) goal.currentAmount = req.body.currentAmount;

    // AUTO COMPLETION
    if (goal.currentAmount >= goal.targetAmount) {
      goal.status = "completed";
    }

    const updatedGoal = await goal.save();

    res.status(200).json({
      success: true,
      message: "Goal updated successfully",
      data: updatedGoal
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};



// GOAL SUMMARY
exports.getGoalSummary = async (req, res) => {
  try {

    const goals = await Goal.find({
      userId: req.user.id
    });

    const summary = calculateSummary(goals);

    res.status(200).json({
      success: true,
      data: summary
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};



// DELETE GOAL
exports.deleteGoal = async (req, res) => {
  try {

    const goal = await Goal.findById(req.params.id);

    if (!goal) {
      return res.status(404).json({
        success: false,
        message: "Goal not found"
      });
    }

    if (goal.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized"
      });
    }

    if (goal.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "Cannot delete a completed goal"
      });
    }

    await goal.deleteOne();

    res.status(200).json({
      success: true,
      message: "Goal deleted successfully"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};



// DEPOSIT TO GOAL
exports.depositToGoal = async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be positive"
      });
    }

    const goal = await Goal.findById(req.params.id);

    if (!goal) {
      return res.status(404).json({
        success: false,
        message: "Goal not found"
      });
    }

    if (goal.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized"
      });
    }

    if (goal.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "Goal already completed"
      });
    }

    const wallet = await Wallet.findOne({
      userId: req.user.id
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found"
      });
    }

    const updatedGoal = await processGoalDeposit(goal, wallet, amount);

    res.status(200).json({
      success: true,
      message: "Amount deposited successfully",
      data: updatedGoal
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};