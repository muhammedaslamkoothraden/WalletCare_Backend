const calculateGoalDetails = (goals) => {
  const today = new Date();

  return goals.map((goal) => {
    const targetAmount = Number(goal.targetAmount) || 0;
    const currentAmount = Number(goal.currentAmount) || 0;

    // Prevent division by zero
    const progressPercentage =
      targetAmount > 0
        ? Math.min((currentAmount / targetAmount) * 100, 100)
        : 0;

    const remainingAmount = Math.max(targetAmount - currentAmount, 0);

    const isOverdue =
      goal.status !== "completed" &&
      goal.targetDate &&
      today > new Date(goal.targetDate);

    return {
      ...goal.toObject(),

      progressPercentage: Number(progressPercentage.toFixed(2)),
      remainingAmount,
      isOverdue
    };
  });
};

const calculateSummary = (goals) => {

  const totalGoals = goals.length;

  const completedGoals =
    goals.filter(g => g.status === "completed").length;

  const activeGoals =
    goals.filter(g => g.status === "active").length;

  const totalTargetAmount =
    goals.reduce((sum, g) => sum + g.targetAmount, 0);

  const totalReservedAmount =
    goals.reduce((sum, g) => sum + g.currentAmount, 0);

  return {
    totalGoals,
    activeGoals,
    completedGoals,
    totalTargetAmount,
    totalReservedAmount
  };
};

module.exports = {
  calculateGoalDetails,
  calculateSummary
};





