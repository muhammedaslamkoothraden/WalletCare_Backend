const express = require('express');
const router = express.Router();

const {
    getAnalyticsDashboard,
    getGoalProgressAnalytics,
    getGoalCategoryStats,
    getMonthlyGoalSavings,
    goalProgressDistribution,
    averageCompletionTime,
    categorySavings  
} = require('../controllers/analyticsController');

router.get('/dashboard', getAnalyticsDashboard);
router.get('/progress',getGoalProgressAnalytics);
router.get('/category',getGoalCategoryStats);
router.get('/monthly',getMonthlyGoalSavings);
router.get('/progress-distribution',goalProgressDistribution);
router.get('/average-completion-time',averageCompletionTime);
router.get('/category-savings', categorySavings);


module.exports = router;