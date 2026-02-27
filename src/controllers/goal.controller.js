const mongoose = require('mongoose');
const Account = require("../models/Account");
const Ledger = require('../models/ledger');
const {
  calculateGoalDetails,
  calculateSummary
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

    if (goal.currentAmount + amount > goal.targetAmount) {
      throw new Error("Deposit exceeds target amount");
    }

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
    if (req.body.targetAmount && req.body.targetAmount < goal.currentAmount) {
      return res.status(400).json({
        success: false,
        message: "Target amount cannot be less than current saved amount"
      });
    }

    // Handle account change
    if (req.body.accountId) {

      if (goal.currentAmount > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot change account while goal has reserved money"
        });
      }

      // Optional: verify account belongs to user
      const newAccount = await Account.findById(req.body.accountId);

      if (!newAccount || newAccount.userId.toString() !== req.user.id.toString()) {
        return res.status(400).json({
          success: false,
          message: "Invalid account"
        });
      }

      goal.accountId = req.body.accountId;
    }

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

    // ✅ UPDATE GOAL
    goal.currentAmount += amount;

    if (goal.currentAmount >= goal.targetAmount) {
      goal.status = "completed";
    }

    await goal.save({ session });

    // ✅ CREATE LEDGER ENTRY
    await Ledger.create([{
      userId: req.user.id,
      accountId: account._id,
      amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
      transactionType: "TRANSFER",
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

    // ✅ Ledger entry
    await Ledger.create([{
      userId: req.user.id,
      accountId: account._id,
      amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
      transactionType: "TRANSFER",
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