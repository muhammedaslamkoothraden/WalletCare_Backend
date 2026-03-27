const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');

const {
    getAnalyticsDashboard,
    getGoalProgressAnalytics,
    getGoalCategoryStats,
    getMonthlyGoalSavings,
    goalProgressDistribution,
    averageCompletionTime,
    categorySavings  
} = require('../controllers/analyticsController');

router.get('/dashboard', authMiddleware, getAnalyticsDashboard);
router.get('/progress', authMiddleware, getGoalProgressAnalytics);
router.get('/category', authMiddleware, getGoalCategoryStats);
router.get('/monthly', authMiddleware, getMonthlyGoalSavings);
router.get('/progress-distribution', authMiddleware, goalProgressDistribution);
router.get('/average-completion-time', authMiddleware, averageCompletionTime);
router.get('/category-savings', authMiddleware, categorySavings);


module.exports = router;