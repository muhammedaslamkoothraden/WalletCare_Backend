const calculateGoalDetails = (goals) => {

  const today = new Date();

  return goals.map((goal) => {

    const targetAmount = Number(goal.targetAmount) || 0;
    const currentAmount = Number(goal.currentAmount) || 0;

    // Calculate progress
    let progressPercentage = 0;

    if (targetAmount > 0) {
      progressPercentage = (currentAmount / targetAmount) * 100;
    }

    if (progressPercentage > 100) {
      progressPercentage = 100;
    }

    const remainingAmount = Math.max(targetAmount - currentAmount, 0);

    const isOverdue =
      goal.status !== "completed" &&
      goal.targetDate &&
      today > new Date(goal.targetDate);

    return {
      ...goal.toObject(),

      progressPercentage: Number(progressPercentage.toFixed(2)),
      remainingAmount: remainingAmount,
      isOverdue: isOverdue
    };

  });
};



const calculateSummary = (goals) => {

  const totalGoals = goals.length;

  const completedGoals =
    goals.filter(goal => goal.status === "completed").length;

  const activeGoals =
    goals.filter(goal => goal.status === "active").length;

  const totalTargetAmount =
    goals.reduce((sum, goal) => sum + Number(goal.targetAmount || 0), 0);

  const totalReservedAmount =
    goals.reduce((sum, goal) => sum + Number(goal.currentAmount || 0), 0);

  const overdueGoals =
    goals.filter(g => g.status === "overdue").length;

  return {
    totalGoals,
    activeGoals,
    completedGoals,
    overdueGoals,
    totalTargetAmount,
    totalReservedAmount
  };

};



module.exports = {
  calculateGoalDetails,
  calculateSummary
};