const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');

const {
    getAnalyticsDashboard,
    getGoalProgressAnalytics,
    getGoalCategoryStats,
    getMonthlyGoalSavings
} = require('../controllers/analyticsController');

router.get('/dashboard', authMiddleware, getAnalyticsDashboard);
router.get('/progress', authMiddleware, getGoalProgressAnalytics);
router.get('/category', authMiddleware, getGoalCategoryStats);
router.get('/monthly', authMiddleware, getMonthlyGoalSavings);

module.exports = router;