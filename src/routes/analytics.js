const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth'); 

const analyticsController = require('../controllers/analyticsController');

router.get('/analytics', authMiddleware, analyticsController.getAnalyticsDashboard);

module.exports = router;