const express = require('express');
const router = express.Router();
// Ensure this path actually leads to your controller file
const analyticsController = require('../controllers/analyticsController');

// Check that 'getAnalyticsOverview' is spelled exactly the same here and in the controller
router.get('/analytics', analyticsController.getAnalyticsOverview);

module.exports = router;