const Goal = require("../models/Goal");

// CREATE GOAL
exports.createGoal = async (req, res) => {
  try {
    // 1️⃣ Take data from request body
    const { title, targetAmount, targetDate } = req.body;

    // 2️⃣ Create goal in database
    
    //  const goal = await Goal.create({
    //     userId: req.user.id,
    //     ...req.body,
    //   });

    const goal = await Goal.create({
      title,
      targetAmount,
      targetDate,
    });

    // 3️⃣ Send response
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
    const goals = await Goal.find();

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
