'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Account = require("../models/Account");
const Ledger = require('../models/ledger');
const Goal = require('../models/Goal');
const { calculateGoalDetails } = require("../services/goal.service");

// ─── CREATE GOAL ──────────────────────────────────────────────────────────────

exports.createGoal = async (req, res) => {
    try {
        const { title, description, category, targetAmount, targetDate, accountId } = req.body;

        if (!title || !category || !targetAmount || !targetDate || !accountId) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }
        if (targetAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Target amount must be positive' });
        }

        const account = await Account.findOne({ _id: accountId, userId: req.user.id });
        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found or not authorized' });
        }

        const goal = await Goal.create({
            userId: req.user.id,
            accountId,
            title,
            description,
            category,
            targetAmount,
            targetDate,
        });

        res.status(201).json({ success: true, message: 'Goal created successfully', data: goal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── GET GOALS ────────────────────────────────────────────────────────────────

exports.getGoals = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const filter = { userId: req.user.id };

        if (req.query.status) filter.status = req.query.status;
        if (req.query.category) filter.category = req.query.category;

        const totalGoals = await Goal.countDocuments(filter);
        const goals = await Goal.find(filter)
            .populate('accountId', 'name')
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ targetDate: 1 });

        const goalsWithDetails = calculateGoalDetails(goals);

        res.status(200).json({
            success: true,
            pagination: { page, limit, totalGoals, totalPages: Math.ceil(totalGoals / limit) },
            data: goalsWithDetails,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── GET GOAL BY ID ───────────────────────────────────────────────────────────

exports.getGoalById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid goal id' });
        }

        const goal = await Goal.findOne({ _id: id, userId: req.user.id })
            .populate('accountId', 'name');
        if (!goal) return res.status(404).json({ success: false, message: 'Goal not found' });

        const goalWithDetails = calculateGoalDetails([goal])[0];
        res.status(200).json({ success: true, data: goalWithDetails });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── UPDATE GOAL ──────────────────────────────────────────────────────────────

exports.updateGoal = async (req, res) => {
    try {
        const goal = await Goal.findById(req.params.id);
        if (!goal) return res.status(404).json({ success: false, message: 'Goal not found' });
        if (goal.userId.toString() !== req.user.id.toString()) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        if (goal.status === 'completed') {
            return res.status(400).json({ success: false, message: 'Cannot modify completed goal' });
        }

        if (req.body.targetAmount !== undefined) {
            if (req.body.targetAmount <= 0) {
                return res.status(400).json({ success: false, message: 'Target amount must be positive' });
            }
            if (req.body.targetAmount < goal.currentAmount) {
                return res.status(400).json({ success: false, message: 'Target amount cannot be less than current saved amount' });
            }
            goal.targetAmount = req.body.targetAmount;
        }

        if (req.body.title) goal.title = req.body.title;
        if (req.body.category) goal.category = req.body.category;
        if (req.body.targetDate) goal.targetDate = req.body.targetDate;

        if (req.body.accountId) {
            if (goal.currentAmount > 0) {
                return res.status(400).json({ success: false, message: 'Cannot change account while goal has reserved money' });
            }
            const newAccount = await Account.findOne({ _id: req.body.accountId, userId: req.user.id });
            if (!newAccount) return res.status(400).json({ success: false, message: 'Invalid account' });
            goal.accountId = req.body.accountId;
        }

        if (goal.currentAmount >= goal.targetAmount) goal.status = 'completed';

        const updatedGoal = await goal.save();
        res.status(200).json({ success: true, message: 'Goal updated successfully', data: updatedGoal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── GET GOAL SUMMARY ─────────────────────────────────────────────────────────

exports.getGoalSummary = async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const summary = await Goal.aggregate([
            { $match: { userId } },
            {
                $group: {
                    _id: null,
                    totalGoals: { $sum: 1 },
                    completedGoals: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                    activeGoals: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                    totalTargetAmount: { $sum: '$targetAmount' },
                    totalReservedAmount: { $sum: '$currentAmount' },
                },
            },
        ]);
        res.status(200).json({ success: true, data: summary[0] || {} });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── DELETE GOAL ──────────────────────────────────────────────────────────────

exports.deleteGoal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const goal = await Goal.findOne({ _id: req.params.id, userId: req.user.id }).session(session);
        if (!goal) throw new Error('Goal not found');

        const account = await Account.findOne({ _id: goal.accountId, userId: req.user.id }).session(session);
        if (!account) throw new Error("Account not found");

        const tDate = req.body.transactedAt ? new Date(req.body.transactedAt) : new Date();
        if (isNaN(tDate.getTime())) throw new Error('Invalid transactedAt date');

        const unlockAmount = goal.currentAmount;
        if (unlockAmount > 0) {
            const available = new Decimal(account.availableBalance.toString());
            const reserved = new Decimal(account.reservedBalance.toString());

            account.availableBalance = mongoose.Types.Decimal128.fromString(available.plus(unlockAmount).toFixed(2));
            account.reservedBalance = mongoose.Types.Decimal128.fromString(reserved.minus(unlockAmount).toFixed(2));
            await account.save({ session });

            await Ledger.create([{
                userId: req.user.id,
                accountId: account._id,
                goalId: goal._id,
                amount: mongoose.Types.Decimal128.fromString(unlockAmount.toFixed(2)),
                transactionType: 'INCOME',
                direction: 'GOAL_DEALLOCATION',
                category: goal.category,
                description: `Goal deleted: ${goal.title}`,
                status: 'COMPLETED',
                idempotencyKey: new mongoose.Types.ObjectId().toString(),
                transactedAt: tDate,
            }], { session });
        }

        await goal.deleteOne({ session });
        await session.commitTransaction();
        res.status(200).json({ success: true, message: 'Goal deleted and funds unlocked' });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: error.message });
    } finally {
        session.endSession();
    }
};

// ─── DEPOSIT TO GOAL ──────────────────────────────────────────────────────────

exports.depositToGoal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { amount, transactedAt } = req.body;
        if (!amount || amount <= 0) throw new Error('Amount must be positive');
        const tDate = transactedAt ? new Date(transactedAt) : new Date();
        if (isNaN(tDate.getTime())) throw new Error('Invalid transactedAt date');

        const goal = await Goal.findOne({ _id: req.params.id, userId: req.user.id }).session(session);
        if (!goal) throw new Error('Goal not found');
        if (goal.status === 'completed') throw new Error('Goal already completed');
        if (goal.currentAmount + amount > goal.targetAmount) throw new Error('Deposit exceeds goal target');

        const account = await Account.findOne({ _id: goal.accountId, userId: req.user.id }).session(session);
        if (!account) throw new Error("Account not found");

        const available = new Decimal(account.availableBalance.toString());
        const reserved = new Decimal(account.reservedBalance.toString());

        if (available.lt(amount)) throw new Error("Insufficient balance");

        account.availableBalance = mongoose.Types.Decimal128.fromString(available.minus(amount).toFixed(2));
        account.reservedBalance = mongoose.Types.Decimal128.fromString(reserved.plus(amount).toFixed(2));
        await account.save({ session });

        goal.currentAmount += amount;

        await Ledger.create([{
            userId: req.user.id,
            accountId: account._id,
            goalId: goal._id,
            amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
            transactionType: 'TRANSFER',
            direction: 'GOAL_ALLOCATION',
            category: goal.category,
            description: `Deposit to goal: ${goal.title}`,
            status: 'COMPLETED',
            idempotencyKey: new mongoose.Types.ObjectId().toString(),
            transactedAt: tDate,
        }], { session });

        if (goal.currentAmount >= goal.targetAmount) {
            goal.status = 'completed';

            const finalReserved = new Decimal(account.reservedBalance.toString());
            account.reservedBalance = mongoose.Types.Decimal128.fromString(
                finalReserved.minus(goal.targetAmount).toFixed(2)
            );
            await account.save({ session });

            await Ledger.create([{
                userId: req.user.id,
                accountId: account._id,
                goalId: goal._id,
                amount: mongoose.Types.Decimal128.fromString(goal.targetAmount.toFixed(2)),
                transactionType: 'EXPENSE',
                direction: 'GOAL_COMPLETION',
                category: goal.category,
                description: `Goal fully funded: ${goal.title}`,
                status: 'COMPLETED',
                idempotencyKey: new mongoose.Types.ObjectId().toString(),
                transactedAt: tDate,
            }], { session });
        }

        await goal.save({ session });
        await session.commitTransaction();
        res.status(200).json({ success: true, message: 'Deposited successfully', data: goal });
    } catch (error) {
        await session.abortTransaction();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        session.endSession();
    }
};

// ─── WITHDRAW FROM GOAL ───────────────────────────────────────────────────────

exports.withdrawFromGoal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { amount, transactedAt } = req.body;
        if (!amount || amount <= 0) throw new Error('Invalid withdrawal amount');
        const tDate = transactedAt ? new Date(transactedAt) : new Date();
        if (isNaN(tDate.getTime())) throw new Error('Invalid transactedAt date');

        const goal = await Goal.findOne({ _id: req.params.id, userId: req.user.id }).session(session);
        if (!goal) throw new Error('Goal not found');
        if (goal.status === 'completed') throw new Error('Cannot withdraw from a completed goal');
        if (goal.currentAmount < amount) throw new Error('Insufficient goal balance');

        const account = await Account.findOne({ _id: goal.accountId, userId: req.user.id }).session(session);
        if (!account) throw new Error("Account not found");

        const available = new Decimal(account.availableBalance.toString());
        const reserved = new Decimal(account.reservedBalance.toString());

        account.reservedBalance = mongoose.Types.Decimal128.fromString(reserved.minus(amount).toFixed(2));
        account.availableBalance = mongoose.Types.Decimal128.fromString(available.plus(amount).toFixed(2));

        goal.currentAmount -= amount;
        if (goal.currentAmount < goal.targetAmount) goal.status = 'active';

        await account.save({ session });

        await goal.save({ session });

        await Ledger.create([{
            userId: req.user.id,
            accountId: account._id,
            goalId: goal._id,
            amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
            transactionType: 'TRANSFER',
            direction: 'GOAL_DEALLOCATION',
            category: goal.category,
            description: `Withdraw from goal: ${goal.title}`,
            status: 'COMPLETED',
            idempotencyKey: new mongoose.Types.ObjectId().toString(),
            transactedAt: tDate,
        }], { session });

        await session.commitTransaction();
        res.status(200).json({ success: true, message: 'Withdrawn successfully' });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: error.message });
    } finally {
        session.endSession();
    }
};

// ─── GOAL PREDICTION ──────────────────────────────────────────────────────────

exports.getGoalPrediction = async (req, res) => {
    try {
        const goals = await Goal.find({ userId: req.user.id, status: 'active' });
        const predictions = goals.map(goal => {
            const remainingAmount = goal.targetAmount - goal.currentAmount;
            const remainingDays = Math.ceil((goal.targetDate - new Date()) / (1000 * 60 * 60 * 24));
            return {
                goalId: goal._id,
                title: goal.title,
                remainingAmount,
                remainingDays: remainingDays > 0 ? remainingDays : 0,
                requiredDailySaving: remainingDays > 0
                    ? (remainingAmount / remainingDays).toFixed(2)
                    : remainingAmount,
            };
        });
        res.status(200).json({ success: true, data: predictions });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── GET ACCOUNT GOAL TRANSITIONS ────────────────────────────────────────────

exports.getAccountGoalTransitions = async (req, res) => {
    try {
        const { accountId } = req.params;

        const account = await Account.findOne({ _id: accountId, userId: req.user.id });
        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        const history = await Ledger.find({
            accountId,
            direction: { $in: ['GOAL_ALLOCATION', 'GOAL_DEALLOCATION'] },
        })
            .sort({ transactedAt: -1 })
            .select('amount direction description transactedAt createdAt');

        res.status(200).json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── SHARE GOAL ───────────────────────────────────────────────────────────────

exports.shareGoal = async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid goal or user ID' });
        }

        const goal = await Goal.findOne({ _id: id, userId: req.user.id });
        if (!goal) {
            return res.status(404).json({ success: false, message: 'Goal not found or not authorized' });
        }

        if (!goal.sharedWith.includes(userId)) {
            goal.sharedWith.push(userId);
            await goal.save();
        }

        res.json({ success: true, message: 'Goal shared successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── GET GOAL HISTORY ─────────────────────────────────────────────────────────

exports.getGoalHistory = async (req, res) => {
    try {
        const goalId = req.params.id;

        if (!mongoose.Types.ObjectId.isValid(goalId)) {
            return res.status(400).json({ success: false, message: 'Invalid goalId' });
        }

        const goal = await Goal.findOne({ _id: goalId, userId: req.user.id });
        if (!goal) {
            return res.status(404).json({ success: false, message: 'Goal not found' });
        }

        const { limit = 20, lastId } = req.query;
        const parsed = parseInt(limit, 10);
        const parsedLimit = Math.min(isNaN(parsed) || parsed < 1 ? 20 : parsed, 100);

        const query = {
            userId: req.user.id,
            goalId: goal._id,
        };

        if (lastId) {
            if (!mongoose.Types.ObjectId.isValid(lastId)) {
                return res.status(400).json({ success: false, message: 'Invalid lastId cursor' });
            }
            const lastTx = await Ledger.findById(lastId).select('transactedAt').lean();
            if (lastTx) {
                query.$or = [
                    { transactedAt: { $lt: lastTx.transactedAt } },
                    { transactedAt: lastTx.transactedAt, _id: { $lt: new mongoose.Types.ObjectId(lastId) } },
                ];
            }
        }

        const history = await Ledger.find(query)
            .sort({ transactedAt: -1, _id: -1 })
            .limit(parsedLimit)
            .lean();

        return res.status(200).json({
            success: true,
            goalId,
            goalTitle: goal.title,
            count: history.length,
            nextCursor: history.length === parsedLimit ? history.at(-1)._id : null,
            data: history.map((tx) => ({
                txid: tx._id,
                direction: tx.direction,
                amount: tx.amount.toString(),
                description: tx.description,
                createdAt: tx.createdAt,
                transactedAt: tx.transactedAt,
            })),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};