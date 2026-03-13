const mongoose = require('mongoose');
const Account = require("../models/Account");
const Ledger = require('../models/ledger');
const Goal = require('../models/Goal');
const { calculateGoalDetails } = require("../services/goal.service");

// CREATE GOAL
exports.createGoal = async (req, res) => {
    try {
        const { title, category, targetAmount, targetDate, accountId } = req.body;

        if (!title || !category || !targetAmount || !targetDate || !accountId) {
            return res.status(400).json({ success: false, message: "All fields are required" });
        }

        if (targetAmount <= 0) {
            return res.status(400).json({ success: false, message: "Target amount must be positive" });
        }

        const account = await Account.findOne({ _id: accountId, userId: req.user.id });
        if (!account) {
            return res.status(404).json({ success: false, message: "Account not found or not authorized" });
        }

        const goal = await Goal.create({
            userId: req.user.id,
            accountId,
            title,
            category,
            targetAmount,
            targetDate
        });

        res.status(201).json({ success: true, message: "Goal created successfully", data: goal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET GOALS WITH PAGINATION & FILTERING 
exports.getGoals = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const filter = { userId: req.user.id };

        if (req.query.status) filter.status = req.query.status;
        if (req.query.category) filter.category = req.query.category;

        const totalGoals = await Goal.countDocuments(filter);
        const goals = await Goal.find(filter)
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ targetDate: 1 });

        const goalsWithDetails = calculateGoalDetails(goals);

        res.status(200).json({
            success: true,
            pagination: { page, limit, totalGoals, totalPages: Math.ceil(totalGoals / limit) },
            data: goalsWithDetails
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET GOAL BY ID
exports.getGoalById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid goal id" });
        }

        const goal = await Goal.findOne({ _id: id, userId: req.user.id });
        if (!goal) return res.status(404).json({ success: false, message: "Goal not found" });

        const goalWithDetails = calculateGoalDetails([goal])[0];
        res.status(200).json({ success: true, data: goalWithDetails });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// UPDATE GOAL
exports.updateGoal = async (req, res) => {
    try {
        const goal = await Goal.findById(req.params.id);
        if (!goal) return res.status(404).json({ success: false, message: "Goal not found" });
        if (goal.userId.toString() !== req.user.id.toString()) {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }
        if (goal.status === "completed") {
            return res.status(400).json({ success: false, message: "Cannot modify completed goal" });
        }

        if (req.body.targetAmount !== undefined) {
            if (req.body.targetAmount <= 0) return res.status(400).json({ success: false, message: "Target amount must be positive" });
            if (req.body.targetAmount < goal.currentAmount) {
                return res.status(400).json({ success: false, message: "Target amount cannot be less than current saved amount" });
            }
            goal.targetAmount = req.body.targetAmount;
        }

        if (req.body.title) goal.title = req.body.title;
        if (req.body.category) goal.category = req.body.category;
        if (req.body.targetDate) goal.targetDate = req.body.targetDate;

        if (req.body.accountId) {
            if (goal.currentAmount > 0) return res.status(400).json({ success: false, message: "Cannot change account while goal has reserved money" });
            const newAccount = await Account.findOne({ _id: req.body.accountId, userId: req.user.id });
            if (!newAccount) return res.status(400).json({ success: false, message: "Invalid account" });
            goal.accountId = req.body.accountId;
        }

        if (goal.currentAmount >= goal.targetAmount) goal.status = "completed";

        const updatedGoal = await goal.save();
        res.status(200).json({ success: true, message: "Goal updated successfully", data: updatedGoal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET GOAL SUMMARY
exports.getGoalSummary = async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const summary = await Goal.aggregate([
            { $match: { userId } },
            {
                $group: {
                    _id: null,
                    totalGoals: { $sum: 1 },
                    completedGoals: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
                    activeGoals: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
                    totalTargetAmount: { $sum: "$targetAmount" },
                    totalReservedAmount: { $sum: "$currentAmount" }
                }
            }
        ]);
        res.status(200).json({ success: true, data: summary[0] || {} });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE GOAL
exports.deleteGoal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const goal = await Goal.findById(req.params.id).session(session);
        if (!goal) throw new Error("Goal not found");
        if (goal.userId.toString() !== req.user.id.toString()) throw new Error("Not authorized");

        const account = await Account.findById(goal.accountId).session(session);
        if (!account) throw new Error("Account not found");

        const unlockAmount = goal.currentAmount;
        if (unlockAmount > 0) {
            const available = parseFloat(account.availableBalance.toString());
            const reserved = parseFloat(account.reservedBalance.toString());

            account.availableBalance = mongoose.Types.Decimal128.fromString((available + unlockAmount).toFixed(2));
            account.reservedBalance = mongoose.Types.Decimal128.fromString((reserved - unlockAmount).toFixed(2));

            await account.save({ session });
            await Ledger.create([{
                userId: req.user.id,
                accountId: account._id,
                amount: mongoose.Types.Decimal128.fromString(unlockAmount.toFixed(2)),
                transactionType: "INCOME",
                direction: "GOAL_DEALLOCATION",
                category: goal.category,
                description: `Goal deleted: ${goal.title}`,
                idempotencyKey: new mongoose.Types.ObjectId().toString()
            }], { session });
        }

        await goal.deleteOne({ session });
        await session.commitTransaction();
        res.status(200).json({ success: true, message: "Goal deleted and funds unlocked" });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: error.message });
    } finally {
        session.endSession();
    }
};

// DEPOSIT TO GOAL
exports.depositToGoal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) throw new Error("Amount must be positive");

        const goal = await Goal.findById(req.params.id).session(session);
        if (!goal) throw new Error("Goal not found");
        if (goal.status === "completed") throw new Error("Goal already completed");
        if (goal.currentAmount + amount > goal.targetAmount) throw new Error("Deposit exceeds goal target");

        const account = await Account.findById(goal.accountId).session(session);
        if (!account) throw new Error("Account not found");

        const available = parseFloat(account.availableBalance.toString());
        const reserved = parseFloat(account.reservedBalance.toString());

        if (available < amount) throw new Error("Insufficient balance");

        // 1. Update Account Balances (Move Available -> Reserved)
        account.availableBalance = mongoose.Types.Decimal128.fromString((available - amount).toFixed(2));
        account.reservedBalance = mongoose.Types.Decimal128.fromString((reserved + amount).toFixed(2));
        await account.save({ session });

        // 2. Update Goal Current Amount
        goal.currentAmount += amount;

        // 3. Create Deposit Ledger
        await Ledger.create([{
            userId: req.user.id,
            accountId: account._id,
            amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
            transactionType: "TRANSFER",
            direction: "GOAL_ALLOCATION",
            category: goal.category,
            description: `deposit to goal ${goal.category}`,
            idempotencyKey: new mongoose.Types.ObjectId().toString()
        }], { session });

        // 4. Handle Goal Completion
        if (goal.currentAmount >= goal.targetAmount) {
            goal.status = "completed";
            
            // Deduct from Reserved (The money is now spent/locked for the goal)
            const finalReserved = parseFloat(account.reservedBalance.toString());
            account.reservedBalance = mongoose.Types.Decimal128.fromString((finalReserved - goal.targetAmount).toFixed(2));
            await account.save({ session });

            // Create Completion Ledger
            await Ledger.create([{
                userId: req.user.id,
                accountId: account._id,
                amount: mongoose.Types.Decimal128.fromString(goal.targetAmount.toFixed(2)),
                transactionType: "EXPENSE",
                direction: "GOAL_COMPLETION",
                category: goal.category,
                description: `Goal fully funded: ${goal.title}`,
                idempotencyKey: new mongoose.Types.ObjectId().toString()
            }], { session });
        }

        await goal.save({ session });
        await session.commitTransaction();

        res.status(200).json({ success: true, message: "Deposited successfully", data: goal });
    } catch (error) {
        await session.abortTransaction();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        session.endSession();
    }
};

// WITHDRAW FROM GOAL
exports.withdrawFromGoal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) throw new Error("Invalid withdrawal amount");

        const goal = await Goal.findById(req.params.id).session(session);
        if (!goal || goal.currentAmount < amount) throw new Error("Insufficient goal balance");

        const account = await Account.findById(goal.accountId).session(session);
        const available = parseFloat(account.availableBalance.toString());
        const reserved = parseFloat(account.reservedBalance.toString());

        account.reservedBalance = mongoose.Types.Decimal128.fromString((reserved - amount).toFixed(2));
        account.availableBalance = mongoose.Types.Decimal128.fromString((available + amount).toFixed(2));

        goal.currentAmount -= amount;
        if (goal.currentAmount < goal.targetAmount) goal.status = "active";

        await account.save({ session });
        await goal.save({ session });

        await Ledger.create([{
            userId: req.user.id,
            accountId: account._id,
            amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
            transactionType: "TRANSFER",
            direction: "GOAL_DEALLOCATION",
            category: goal.category,
            description: `Withdraw from goal: ${goal.title}`,
            idempotencyKey: new mongoose.Types.ObjectId().toString()
        }], { session });

        await session.commitTransaction();
        res.status(200).json({ success: true, message: "Withdrawn successfully" });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: error.message });
    } finally {
        session.endSession();
    }
};

// GOAL PREDICTION
exports.getGoalPrediction = async (req, res) => {
    try {
        const goals = await Goal.find({ userId: req.user.id, status: "active" });
        const predictions = goals.map(goal => {
            const remainingAmount = goal.targetAmount - goal.currentAmount;
            const remainingDays = Math.ceil((goal.targetDate - new Date()) / (1000 * 60 * 60 * 24));
            return {
                goalId: goal._id,
                title: goal.title,
                remainingAmount,
                remainingDays: remainingDays > 0 ? remainingDays : 0,
                requiredDailySaving: remainingDays > 0 ? (remainingAmount / remainingDays).toFixed(2) : remainingAmount
            };
        });
        res.status(200).json({ success: true, data: predictions });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
// GET ONLY ALLOCATIONS AND DEALLOCATIONS FOR AN ACCOUNT
exports.getAccountGoalTransitions = async (req, res) => {
  try {
    const { accountId } = req.params;

    // 1. Ownership check
    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    // 2. Fetch only the "movement" entries
    const history = await Ledger.find({
      accountId: accountId,
      direction: { $in: ["GOAL_ALLOCATION", "GOAL_DEALLOCATION"] }
    })
    .sort({ createdAt: -1 }) // Show most recent first
    .select('amount direction description createdAt'); // Only send necessary fields

    res.status(200).json({
      success: true,
      data: history
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// SHARING GOAL WITH ANOTHER USER
exports.shareGoal =
async (req, res) => {

  const { id } = req.params;
  const { userId } = req.body;

  const goal = await Goal.findById(id);

  if (!goal) {
    return res.status(404).json({
      message: "Goal not found"
    });
  }

  goal.sharedWith.push(userId);

  await goal.save();

  res.json({
    success: true,
    message: "Goal shared successfully"
  });

};