const Goal = require("../models/Goal");

const updateGoalStatus = async () => {
  try {
    const today = new Date();

    await Goal.updateMany(
      {
        status: "active",
        targetDate: { $lt: today }
      },
      {
        $set: { status: "overdue" }
      }
    );

    console.log("Goal status updated");
  } catch (error) {
    console.error("Goal status job error:", error);
  }
};

module.exports = updateGoalStatus;