const calculateGoalDetails = (goals) => {

  const today = new Date();

  return goals.map((goal) => {

    const targetAmount = Number(goal.targetAmount) || 0;
    const currentAmount = Number(goal.currentAmount) || 0;

    // Progress %
    let progressPercentage = 0;

    if (targetAmount > 0) {
      progressPercentage = (currentAmount / targetAmount) * 100;
    }

    progressPercentage = Math.min(progressPercentage, 100);

    // Remaining amount
    const remainingAmount = Math.max(targetAmount - currentAmount, 0);

    // Days left
    let daysLeft = null;

    if (goal.targetDate) {
      const targetDate = new Date(goal.targetDate);
      const diffTime = targetDate - today;

      daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (daysLeft < 0) {
        daysLeft = 0;
      }
    }

    // Required daily saving
    let requiredDailySaving = 0;

    if (daysLeft && daysLeft > 0) {
      requiredDailySaving = remainingAmount / daysLeft;
    }

    // Overdue flag
    const isOverdue =
      goal.status !== "completed" &&
      goal.targetDate &&
      today > new Date(goal.targetDate);

    return {
      ...goal.toObject(),

      progressPercentage: Number(progressPercentage.toFixed(2)),
      remainingAmount: Number(remainingAmount.toFixed(2)),
      daysLeft: daysLeft,
      requiredDailySaving: Number(requiredDailySaving.toFixed(2)),
      isOverdue: isOverdue
    };

  });
};



// const calculateSummary = (goals) => {

//   const totalGoals = goals.length;

//   const completedGoals =
//     goals.filter(goal => goal.status === "completed").length;

//   const activeGoals =
//     goals.filter(goal => goal.status === "active").length;

//   const totalTargetAmount =
//     goals.reduce((sum, goal) => sum + Number(goal.targetAmount || 0), 0);

//   const totalReservedAmount =
//     goals.reduce((sum, goal) => sum + Number(goal.currentAmount || 0), 0);

//   const overdueGoals =
//     goals.filter(g => g.status === "overdue").length;

//   return {
//     totalGoals,
//     activeGoals,
//     completedGoals,
//     overdueGoals,
//     totalTargetAmount,
//     totalReservedAmount
//   };

// };



module.exports = {
  calculateGoalDetails,
  // calculateSummary

};