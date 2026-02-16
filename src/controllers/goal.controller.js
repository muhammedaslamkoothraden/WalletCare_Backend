const Goal = require("../models/Goal");

// CREATE GOAL
exports.createGoal = async (req, res) => {
  try {
    const { title, targetAmount, targetDate } = req.body;

    if (!title || !targetAmount || !targetDate) {
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
      targetAmount,
      targetDate,
    });

    res.status(201).json({
      success: true,
      message: "Goal created successfully",
      data: goal,
    });

  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// GET ALL GOALS
exports.getGoals = async (req, res) => {
  try {
    const goals = await Goal.find({
      userId: req.user.id
    });

    const goalsWithPercentage = goals.map(goal => {
      const percentage = Math.min(
        (goal.currentAmount / goal.targetAmount) * 100,
        100
      );

      return {
        ...goal.toObject(),
        percentage: Number(percentage.toFixed(2))
      };
    });

    const today = new Date();

    const goalsWithDetails = goals.map(goal => {

      const percentage = Math.min(
        (goal.currentAmount / goal.targetAmount) * 100,
        100
      );

      const isOverdue =
        goal.status !== "completed" &&
        today > goal.targetDate;

      return {
        ...goal.toObject(),
        percentage: Number(percentage.toFixed(2)),
        overdue: isOverdue
      };
    });

    res.status(200).json({
      success: true,
      data: goalsWithDetails
    });

    res.status(200).json({
      success: true,
      data: goals,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

//update goal
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
    if (req.body.targetAmount) goal.targetAmount = req.body.targetAmount;
    if (req.body.targetDate) goal.targetDate = req.body.targetDate;
    if (req.body.currentAmount >= 0) goal.currentAmount = req.body.currentAmount;

    // AUTO COMPLETION LOGIC
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

//goal summary
exports.getGoalSummary = async (req, res) => {
  try {

    const goals = await Goal.find({ userId: req.user.id });

    const totalGoals = goals.length;
    const completedGoals = goals.filter(g => g.status === "completed").length;
    const activeGoals = goals.filter(g => g.status === "active").length;

    const totalTargetAmount = goals.reduce((sum, g) => sum + g.targetAmount, 0);
    const totalSavedAmount = goals.reduce((sum, g) => sum + g.currentAmount, 0);

    res.status(200).json({
      success: true,
      data: {
        totalGoals,
        activeGoals,
        completedGoals,
        totalTargetAmount,
        totalSavedAmount
      }
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

    // Ownership check
    if (goal.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this goal"
      });
    }

    // Optional: Prevent deleting completed goals
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





