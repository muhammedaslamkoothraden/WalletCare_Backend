const mongoose = require('mongoose');
const Account = require("../models/Account");
const Ledger = require('../models/Ledger');
const idempotencyKey = new mongoose.Types.ObjectId().toString();
const {
  calculateGoalDetails
} = require("../services/goal.service");
const Goal = require('../models/Goal');
// CREATE GOAL
exports.createGoal = async (req, res) => {
  try {
    const { title, category, targetAmount, targetDate, accountId } = req.body;

    // 1️⃣ Validate required fields
    if (!title || !category || !targetAmount || !targetDate || !accountId) {
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

    // 2️⃣ Check account exists & belongs to user
    const account = await Account.findOne({
      _id: accountId,
      userId: req.user.id
    });

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found or not authorized"
      });
    }

    // 3️⃣ Create goal
    const goal = await Goal.create({
      userId: req.user.id,
      accountId,
      title,
      category,
      targetAmount,
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

// GET GOALS WITH PAGINATION & FILTERING 
exports.getGoals = async (req, res) => {
  try {

    // pagination values
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    // filtering
    const filter = { userId: req.user.id };

    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.category) {
      filter.category = req.query.category;
    }

    // count total goals
    const totalGoals = await Goal.countDocuments(filter);

    // fetch goals with pagination
    const goals = await Goal.find(filter)
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ targetDate: 1 });

    // calculate progress, remaining etc
    const goalsWithDetails = calculateGoalDetails(goals);

    res.status(200).json({
      success: true,

      pagination: {
        page,
        limit,
        totalGoals,
        totalPages: Math.ceil(totalGoals / limit)
      },

      data: goalsWithDetails

    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

//get goal by id
exports.getGoalById = async (req, res) => {
  try {

    const { id } = req.params;

    // Optional improvement: validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid goal id"
      });
    }
    

    const goal = await Goal.findOne({
      _id: id,
      userId: req.user.id
    });

    if (!goal) {
      return res.status(404).json({
        success: false,
        message: "Goal not found"
      });
    }

    // reuse service
    const goalWithDetails = calculateGoalDetails([goal])[0];

    res.status(200).json({
      success: true,
      data: goalWithDetails
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

    if (req.body.targetAmount !== undefined) {
      if (req.body.targetAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: "Target amount must be positive"
        });
      }

      if (req.body.targetAmount < goal.currentAmount) {
        return res.status(400).json({
          success: false,
          message: "Target amount cannot be less than current saved amount"
        });
      }

      goal.targetAmount = req.body.targetAmount;
    }

    if (req.body.title) goal.title = req.body.title;
    if (req.body.category) goal.category = req.body.category;
    if (req.body.targetDate) goal.targetDate = req.body.targetDate;

    // Handle account change
    if (req.body.accountId) {

      if (goal.currentAmount > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot change account while goal has reserved money"
        });
      }

      const newAccount = await Account.findById(req.body.accountId);

      if (!newAccount || newAccount.userId.toString() !== req.user.id.toString()) {
        return res.status(400).json({
          success: false,
          message: "Invalid account"
        });
      }

      goal.accountId = req.body.accountId;
    }

    // Auto complete check
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

    const userId = new mongoose.Types.ObjectId(req.user.id);

    const summary = await Goal.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          totalGoals: { $sum: 1 },
          completedGoals: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, 1, 0]
            }
          },
          activeGoals: {
            $sum: {
              $cond: [{ $eq: ["$status", "active"] }, 1, 0]
            }
          },
          totalTargetAmount: { $sum: "$targetAmount" },
          totalReservedAmount: { $sum: "$currentAmount" }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: summary[0] || {}
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


//delete goal and unlock reserved money
exports.deleteGoal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const goal = await Goal.findById(req.params.id).session(session);

    if (!goal) {
      throw new Error("Goal not found");
    }

    if (goal.userId.toString() !== req.user.id.toString()) {
      throw new Error("Not authorized");
    }

    const account = await Account.findById(goal.accountId).session(session);

    if (!account) {
      throw new Error("Account not found");
    }

    const unlockAmount = goal.currentAmount;

    if (unlockAmount > 0) {
      const available = parseFloat(account.availableBalance.toString());
      const reserved = parseFloat(account.reservedBalance.toString());

      account.availableBalance = mongoose.Types.Decimal128.fromString(
        (available + unlockAmount).toFixed(2)
      );

      account.reservedBalance = mongoose.Types.Decimal128.fromString(
        (reserved - unlockAmount).toFixed(2)
      );

      await account.save({ session });

      await Ledger.create([{
        userId: req.user.id,
        accountId: account._id,
        amount: mongoose.Types.Decimal128.fromString(unlockAmount.toFixed(2)),
        transactionType: "INCOME",
        direction: "GOAL_DEALLOCATION",
        category: "Goal",
        description: `Goal deleted: ${goal.title}`,
        idempotencyKey: new mongoose.Types.ObjectId().toString()
      }], { session });
    }

    await goal.deleteOne({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Goal deleted and funds unlocked"
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};



// DEPOSIT TO GOAL
exports.depositToGoal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be positive"
      });
    }

    const goal = await Goal.findById(req.params.id).session(session);

    if (!goal) {
      throw new Error("Goal not found");
    }

    if (goal.userId.toString() !== req.user.id.toString()) {
      throw new Error("Not authorized");
    }

    if (goal.status === "completed") {
      throw new Error("Goal already completed");
    }

    console.log("Type of Account:", typeof Account);
    console.log("Account keys:", Object.keys(Account));

    // ✅ FIND ACCOUNT (NOT WALLET)
    const account = await Account.findById(goal.accountId).session(session);

    if (!account) {
      throw new Error("Account not found");
    }

    const available = parseFloat(account.availableBalance.toString());

    if (available < amount) {
      throw new Error("Insufficient balance");
    }

    // ✅ MOVE MONEY: Available -> Reserved
    account.availableBalance = mongoose.Types.Decimal128.fromString(
      (available - amount).toFixed(2)
    );

    account.reservedBalance = mongoose.Types.Decimal128.fromString(
      (
        parseFloat(account.reservedBalance.toString()) + amount
      ).toFixed(2)
    );
    if (goal.currentAmount + amount > goal.targetAmount) {
      throw new Error("Deposit exceeds goal target");
    }

    await account.save({ session });

    // goal completion 
    goal.currentAmount += amount;

    let isCompleted = false;

    if (goal.currentAmount >= goal.targetAmount) {

      goal.status = "completed";
      isCompleted = true;

      const reserved = parseFloat(account.reservedBalance.toString());

      // Reduce reserved balance because money is now spent
      account.reservedBalance = mongoose.Types.Decimal128.fromString(
        (reserved - goal.targetAmount).toFixed(2)
      );

      await account.save({ session });

      // Create expense ledger entry for goal completion
      await Ledger.create([{
        userId: req.user.id,
        accountId: account._id,
        amount: mongoose.Types.Decimal128.fromString(goal.targetAmount.toFixed(2)),
        transactionType: "EXPENSE",
        direction: "GOAL_COMPLETION",
        category: "Goal",
        description: `Goal completed: ${goal.title}`,
        idempotencyKey: new mongoose.Types.ObjectId().toString()
      }], { session });

    }

    await goal.save({ session });

    // ✅ CHECK FOR DUPLICATE LEDGER ENTRY
    const existing = await Ledger.findOne({ idempotencyKey });

    if (existing) {
      throw new Error("Duplicate request");
    }

    // ✅ CREATE LEDGER ENTRY DEPOSITING TO GOAL
    await Ledger.create([{
      userId: req.user.id,
      accountId: account._id,
      amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
      transactionType:"EXPENSE",
      direction: "GOAL_ALLOCATION",
      category: "Goal",
      description: `Deposit to goal: ${goal.title}`,
      idempotencyKey: new mongoose.Types.ObjectId().toString()
    }], { session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Amount deposited successfully",
      data: goal
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
// WITHDRAW FROM GOAL
exports.withdrawFromGoal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      throw new Error("Invalid withdrawal amount");
    }

    const goal = await Goal.findById(req.params.id).session(session);
    if (!goal) throw new Error("Goal not found");

    if (goal.userId.toString() !== req.user.id.toString()) {
      throw new Error("Not authorized");
    }

    if (goal.currentAmount < amount) {
      throw new Error("Insufficient goal balance");
    }

    const account = await Account.findById(goal.accountId).session(session);
    if (!account) throw new Error("Account not found");

    // ✅ Convert Decimal128 safely
    const available = parseFloat(account.availableBalance.toString());
    const reserved = parseFloat(account.reservedBalance.toString());

    if (reserved < amount) {
      throw new Error("Insufficient reserved balance");
    }

    // ✅ Move money: Reserved ➜ Available
    account.reservedBalance = mongoose.Types.Decimal128.fromString(
      (reserved - amount).toFixed(2)
    );

    account.availableBalance = mongoose.Types.Decimal128.fromString(
      (available + amount).toFixed(2)
    );

    // ✅ Update goal
    goal.currentAmount -= amount;

    if (goal.currentAmount < goal.targetAmount) {
      goal.status = "active";
    }

    await account.save({ session });
    await goal.save({ session });

    // ✅ Check for duplicate ledger entry
    const existing = await Ledger.findOne({ idempotencyKey });

    if (existing) {
      throw new Error("Duplicate request");
    }

    // ✅ Ledger entry
    await Ledger.create([{
      userId: req.user.id,
      accountId: account._id,
      amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
      transactionType: "INCOME",
      direction: "GOAL_DEALLOCATION",
      category: "Goal",
      description: `Withdraw from goal: ${goal.title}`,
      idempotencyKey: new mongoose.Types.ObjectId().toString()
    }], { session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Withdrawn from goal successfully"
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// GOAL PREDICTION
exports.getGoalPrediction = async (req, res) => {
  try {

    const goals = await Goal.find({
      userId: req.user.id,
      status: "active"
    });

    const predictions = goals.map(goal => {

      const remainingAmount =
        goal.targetAmount - goal.currentAmount;

      const today = new Date();

      const remainingDays =
        Math.ceil((goal.targetDate - today) /
          (1000 * 60 * 60 * 24));

      const requiredDailySaving =
        remainingDays > 0
          ? remainingAmount / remainingDays
          : remainingAmount;

      return {
        goalId: goal._id,
        title: goal.title,
        remainingAmount,
        remainingDays,
        requiredDailySaving
      };
    });

    res.status(200).json({
      success: true,
      data: predictions
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};