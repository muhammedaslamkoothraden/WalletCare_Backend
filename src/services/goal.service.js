const calculateGoalDetails = (goals) => {
  const today = new Date();

  return goals.map(goal => {

    const percentage = goal.targetAmount > 0
      ? Math.min(
        (goal.currentAmount / goal.targetAmount) * 100,
        100
      )
      : 0;

    const overdue =
      goal.status !== "completed" &&
      today > new Date(goal.targetDate);

    return {
      ...goal.toObject(),
      percentage: Number(percentage.toFixed(2)),
      overdue
    };
  });
};

const processGoalDeposit = async (goal, wallet, amount) => {

  if (wallet.balance < amount) {
    throw new Error("Insufficient wallet balance");
  }

  // 1️⃣ Deduct from wallet
  wallet.balance -= amount;

  // 2️⃣ Add to savings
  wallet.savingsBalance += amount;

  // 3️⃣ Add to goal
  goal.currentAmount += amount;

  // 4️⃣ Complete if reached
  if (goal.currentAmount >= goal.targetAmount) {
    goal.status = "completed";
  }

  await wallet.save();
  await goal.save();

  const Transaction = require("../models/transaction");

  await Transaction.create({
    userId: wallet.userId,
    walletId: wallet._id,
    amount: amount,
    type: "expense",
    category: "Goal Deposit",
    description: `Deposit to goal: ${goal.title}`
  });

  return goal;
};

const calculateSummary = (goals) => {

  const totalGoals = goals.length;

  const completedGoals =
    goals.filter(g => g.status === "completed").length;

  const activeGoals =
    goals.filter(g => g.status === "active").length;

  const totalTargetAmount =
    goals.reduce((sum, g) => sum + g.targetAmount, 0);

  const totalSavedAmount =
    goals.reduce((sum, g) => sum + g.currentAmount, 0);

  return {
    totalGoals,
    activeGoals,
    completedGoals,
    totalTargetAmount,
    totalSavedAmount
  };
};

module.exports = {
  calculateGoalDetails,
  calculateSummary,
  processGoalDeposit
};



