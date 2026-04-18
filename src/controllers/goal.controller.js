'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Account = require("../models/Account");
const Ledger = require('../models/Ledger');
const Goal = require('../models/Goal');
const { calculateGoalDetails } = require("../services/goal.service");
const { createNotification } = require('../services/notification.service');

// ─── UTILITIES ────────────────────────────────────────────────────────────────

/**
 * Enterprise-grade transaction wrapper with Exponential Backoff Retries.
 * Catches MongoDB TransientTransactionErrors and VersionErrors (OCC) and retries safely.
 */
async function executeWithRetry(operation, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const result = await operation(session);
            await session.commitTransaction();
            return result;
        } catch (error) {
            await session.abortTransaction().catch(() => { });
            const isTransient = error.code === 112 ||
                error.hasErrorLabel?.('TransientTransactionError') ||
                error.name === 'VersionError';

            if (isTransient && attempt < maxRetries) {
                await new Promise(res => setTimeout(res, Math.random() * 50 * attempt));
                continue;
            }
            throw error;
        } finally {
            session.endSession();
        }
    }
}

/**
 * Safely updates available balance using an atomic DB pipeline to prevent TOCTOU races.
 * If balance drops below zero, it throws an error which aborts the session transaction.
 */
async function updateAvailableBalance(accountId, userId, delta, session) {
    const account = await Account.findOneAndUpdate(
        { _id: accountId, userId },
        [
            {
                $set: {
                    availableBalance: {
                        $let: {
                            vars: {
                                cur: { $toDecimal: { $ifNull: ['$availableBalance', '0'] } },
                                deltaStr: { $toDecimal: delta.toFixed(2) },
                            },
                            in: { $add: ['$$cur', '$$deltaStr'] },
                        },
                    },
                    lastTransactionAt: new Date(),
                    updatedAt: new Date()
                }
            }
        ],
        { new: true, session, runValidators: false, updatePipeline: true }
    );

    if (!account) throw new Error('Account not found or not authorized');

    // Inside a transaction, we can safely check the result and abort if negative
    if (new Decimal(account.availableBalance.toString()).isNegative()) {
        throw new Error('Insufficient available balance in source account');
    }

    return account;
}

// ─── 1. CREATE GOAL ───────────────────────────────────────────────────────────

exports.createGoal = async (req, res) => {
    try {
        const { title, description, category, targetAmount, targetDate } = req.body || {};

        if (!title || !category || !targetAmount || !targetDate) {
            return res.status(400).json({ success: false, message: 'Title, category, targetAmount, and targetDate are required' });
        }
        if (targetAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Target amount must be positive' });
        }

        // --- NEW: Check for existing goal with the same title ---
        // We use a regex for a case-insensitive exact match
        const existingGoal = await Goal.findOne({
            userId: req.user.id,
            title: { $regex: new RegExp(`^${title}$`, 'i') } 
        });

        if (existingGoal) {
            // 409 Conflict is the semantic HTTP status for duplicate resource states
            return res.status(409).json({ 
                success: false, 
                message: `You already have an active goal named "${title}". Please choose a different name.` 
            });
        }
        // ---------------------------------------------------------

        const goal = await Goal.create({
            userId: req.user.id,
            title,
            description,
            category,
            targetAmount,
            targetDate,
            currentAmount: 0,
            status: 'active'
        });

        res.status(201).json({ success: true, message: 'Goal created successfully', data: goal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── 2. DEPOSIT TO GOAL (The Expense) ─────────────────────────────────────────

exports.depositToGoal = async (req, res) => {
    try {
        const { accountId, amount, idempotencyKey, transactedAt } = req.body || {};

        if (!accountId) return res.status(400).json({ success: false, message: 'Source accountId is required' });
        if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Amount must be positive' });
        if (!idempotencyKey) return res.status(400).json({ success: false, message: 'idempotencyKey is required' });

        const depositAmount = new Decimal(amount.toString());
        const tDate = transactedAt ? new Date(transactedAt) : new Date();

        const result = await executeWithRetry(async (session) => {
            const goal = await Goal.findOne({ _id: req.params.id, userId: req.user.id }).session(session);
            if (!goal) throw new Error('Goal not found');

            const existingLedger = await Ledger.findOne({ userId: req.user.id, idempotencyKey }).session(session).lean();
            if (existingLedger) {
                const conflictError = new Error('Duplicate transaction');
                conflictError.isDuplicate = true;
                conflictError.ledgerId = existingLedger._id;
                throw conflictError;
            }

            // Deduct from account available balance
            const account = await updateAvailableBalance(accountId, req.user.id, depositAmount.negated(), session);

            // Update Goal logic
            const currentAmt = new Decimal(goal.currentAmount.toString());
            const targetAmt = new Decimal(goal.targetAmount.toString());
            const newGoalAmount = currentAmt.plus(depositAmount);

            goal.currentAmount = newGoalAmount.toNumber();

            const isNowAchieved = newGoalAmount.greaterThanOrEqualTo(targetAmt);

            if (isNowAchieved && goal.status !== 'completed') {
                goal.status = 'completed';
            }

            await goal.save({ session });

           const [ledger] = await Ledger.create([{
                userId: req.user.id,
                accountId: account._id,
                goalId: goal._id,
                amount: mongoose.Types.Decimal128.fromString(depositAmount.toFixed(2)),
                transactionType: 'EXPENSE',
                direction: 'GOAL_ALLOCATION',
                category: goal.category,
                description: isNowAchieved ? `Goal Completed: ${goal.title}` : `Saved to ${goal.title}`,
                status: 'COMPLETED',
                idempotencyKey,
                transactedAt: tDate,
                // 🎯 ADD THIS LINE:
                runningBalance: mongoose.Types.Decimal128.fromString(account.availableBalance.toString())
            }], { session });

            // 🎯 This checks if THIS specific deposit pushed it from "active" to "completed"
            const justFinished = isNowAchieved && currentAmt.lessThan(targetAmt);

            return { goal, account, ledgerId: ledger._id, justFinished };
        });

        // 🔥 THE FIX: We only trigger the notification if it JUST crossed the finish line!
        if (result.justFinished) {
            createNotification(
                req.user.id,
                `Milestone Reached: Your savings goal '${result.goal.title}' is now fully funded.`,
                'goal_completed'
            ).catch(console.warn);
        }

        return res.status(200).json({
            success: true,
            message: 'Deposited successfully',
            txid: result.ledgerId,
            data: result.goal,
            availableBalance: result.account.availableBalance.toString(),
            justFinished: result.justFinished
        });

    } catch (error) {
        if (error.isDuplicate) return res.status(409).json({ success: true, duplicate: true, txid: error.ledgerId });
        return res.status(400).json({ success: false, message: error.message });
    }
};

// ─── WITHDRAW FROM GOAL ───────────────────────────────────────────────────────

exports.withdrawFromGoal = async (req, res) => {
    try {
        const { accountId, amount, idempotencyKey, transactedAt } = req.body || {};

        if (!accountId) return res.status(400).json({ success: false, message: 'Destination accountId is required' });
        if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Amount must be positive' });
        if (!idempotencyKey) return res.status(400).json({ success: false, message: 'idempotencyKey is required' });

        const withdrawAmount = new Decimal(amount.toString());
        const tDate = transactedAt ? new Date(transactedAt) : new Date();

        const result = await executeWithRetry(async (session) => {
            const goal = await Goal.findOne({ _id: req.params.id, userId: req.user.id }).session(session);
            if (!goal) throw new Error('Goal not found');

            // 🛠️ FIX: Removed the "Cannot withdraw from a completed goal" error block!

            const currentGoalAmount = new Decimal(goal.currentAmount.toString());
            if (currentGoalAmount.lessThan(withdrawAmount)) {
                throw new Error('Insufficient funds in this goal');
            }

            const existingLedger = await Ledger.findOne({ userId: req.user.id, idempotencyKey }).session(session).lean();
            if (existingLedger) {
                const conflictError = new Error('Duplicate transaction');
                conflictError.isDuplicate = true;
                conflictError.ledgerId = existingLedger._id;
                throw conflictError;
            }

            // Add to account available balance
            const account = await updateAvailableBalance(accountId, req.user.id, withdrawAmount, session);

            // Update Goal
            goal.currentAmount = currentGoalAmount.minus(withdrawAmount).toNumber();

            // 🛠️ FIX: If they withdraw from a completed goal, it automatically reactivates!
            if (goal.currentAmount < goal.targetAmount) goal.status = 'active';
            await goal.save({ session });

          const [ledger] = await Ledger.create([{
                userId: req.user.id,
                accountId: account._id,
                goalId: goal._id,
                amount: mongoose.Types.Decimal128.fromString(withdrawAmount.toFixed(2)),
                transactionType: 'INCOME',
                direction: 'GOAL_DEALLOCATION',
                category: 'Withdrawal',
                description: `Withdrawn from ${goal.title} to ${account.name}`,
                status: 'COMPLETED',
                idempotencyKey,
                transactedAt: tDate,
                runningBalance: mongoose.Types.Decimal128.fromString(account.availableBalance.toString())
            }], { session });

            return { goal, account, ledgerId: ledger._id };
        });

        return res.status(200).json({
            success: true,
            message: 'Withdrawn successfully',
            txid: result.ledgerId,
            data: result.goal,
            availableBalance: result.account.availableBalance.toString()
        });

    } catch (error) {
        if (error.isDuplicate) return res.status(409).json({ success: true, duplicate: true, txid: error.ledgerId });
        return res.status(400).json({ success: false, message: error.message });
    }
};

// ─── UPDATE GOAL ───────────────────────────────────────────────────────────

exports.updateGoal = async (req, res) => {
    try {
        const body = req.body || {};
        const goal = await Goal.findById(req.params.id);

        if (!goal) return res.status(404).json({ success: false, message: 'Goal not found' });
        if (goal.userId.toString() !== req.user.id.toString()) return res.status(403).json({ success: false, message: 'Not authorized' });

        // 🛠️ FIX: Removed the "Cannot modify completed goal" lock

        if (body.title) goal.title = body.title;
        if (body.targetDate) goal.targetDate = body.targetDate;

        if (body.targetAmount !== undefined) {
            if (body.targetAmount <= 0) return res.status(400).json({ success: false, message: 'Target amount must be positive' });
            if (body.targetAmount < goal.currentAmount) return res.status(400).json({ success: false, message: 'Target amount cannot be less than currently saved amount' });
            goal.targetAmount = body.targetAmount;
        }

        if (body.category) {
            // 🛠️ FIX: Removed the "hasMoney" check. Category can be changed anytime now!
            goal.category = body.category;
        }

        // Check if the update instantly completes or reactivates the goal
        if (goal.currentAmount >= goal.targetAmount) {
            goal.status = 'completed';
        } else {
            goal.status = 'active';
        }

        const updatedGoal = await goal.save();
        res.status(200).json({ success: true, message: 'Goal updated successfully', data: updatedGoal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
// ─── 4. DELETE GOAL ───────────────────────────────────────────────────────────

exports.deleteGoal = async (req, res) => {
    try {
        // 1. Find the goal first (without deleting it)
        const goal = await Goal.findOne({
            _id: req.params.id,
            userId: req.user.id
        });

        if (!goal) {
            return res.status(404).json({ success: false, message: 'Goal not found' });
        }

        // 2. Check if the goal contains any saved amount
        if (goal.currentAmount > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `Cannot delete goal. Please withdraw or transfer the remaining ₹${goal.currentAmount} before deleting.` 
            });
        }

        // 3. If the amount is 0, it is safe to delete
        await goal.deleteOne();

        return res.status(200).json({ success: true, message: 'Goal deleted successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── READ OPERATIONS (GETTERS) ────────────────────────────────────────────────

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
            data: goalsWithDetails,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getGoalById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid goal id' });

        const goal = await Goal.findOne({ _id: id, userId: req.user.id });
        if (!goal) return res.status(404).json({ success: false, message: 'Goal not found' });

        const goalWithDetails = calculateGoalDetails([goal])[0];
        res.status(200).json({ success: true, data: goalWithDetails });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

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
                    totalSavedAmount: { $sum: '$currentAmount' },
                },
            },
        ]);
        res.status(200).json({ success: true, data: summary[0] || {} });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

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
                requiredDailySaving: remainingDays > 0 ? (remainingAmount / remainingDays).toFixed(2) : remainingAmount,
            };
        });
        res.status(200).json({ success: true, data: predictions });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getAccountGoalTransitions = async (req, res) => {
    try {
        const { accountId } = req.params;
        const account = await Account.findOne({ _id: accountId, userId: req.user.id });
        if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

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

exports.shareGoal = async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body || {};

        if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid goal or user ID' });
        }

        const goal = await Goal.findOne({ _id: id, userId: req.user.id });
        if (!goal) return res.status(404).json({ success: false, message: 'Goal not found or not authorized' });

        if (!goal.sharedWith.includes(userId)) {
            goal.sharedWith.push(userId);
            await goal.save();
        }

        res.json({ success: true, message: 'Goal shared successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

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
        const parsedLimit = Math.min(parseInt(limit, 10) || 20, 100);

        const query = {
            userId: req.user.id,
            goalId: goal._id,
            status: { $in: ['COMPLETED', 'PENDING'] },
        };

        // ─── Pagination Logic ────────────────────────────────────────────────
        if (lastId) {
            const lastTx = await Ledger.findById(lastId).select('transactedAt').lean();
            if (lastTx) {
                query.$or = [
                    { transactedAt: { $lt: lastTx.transactedAt } },
                    { transactedAt: lastTx.transactedAt, _id: { $lt: new mongoose.Types.ObjectId(lastId) } },
                ];
            }
        }

        // ─── Reversal Exclusion Logic ────────────────────────────────────────
        // We find all reversals for this goal to hide both the reversal AND the parent
        const reversals = await Ledger
            .find({ userId: req.user.id, goalId: goal._id, direction: 'REVERSAL' })
            .select('_id parentTransactionId')
            .lean();

        const excludedIds = new Set();
        for (const r of reversals) {
            excludedIds.add(r._id.toString());
            if (r.parentTransactionId) excludedIds.add(r.parentTransactionId.toString());
        }

        if (excludedIds.size > 0) {
            query._id = { $nin: [...excludedIds].map(id => new mongoose.Types.ObjectId(id)) };
        }

        // ─── Execution ───────────────────────────────────────────────────────
        const history = await Ledger.find(query)
            .populate('accountId', 'name') // ✨ Crucial: Populate so Flutter knows which account was used
            .sort({ transactedAt: -1, _id: -1 })
            .limit(parsedLimit)
            .lean();

        return res.status(200).json({
            success: true,
            goalId,
            goalTitle: goal.title,
            count: history.length,
            nextCursor: history.length === parsedLimit ? history.at(-1)._id : null,
            data: history.map(tx => ({
                ...tx, // ✨ FIX: Spread full object so Flutter gets _id, accountId, category, type
                amount: tx.amount.toString(),
                accountName: tx.accountId?.name || 'Unknown Account', // Flattened for easy UI access
            })),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};