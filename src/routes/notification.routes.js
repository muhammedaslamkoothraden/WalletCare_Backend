const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');

router.get('/', notificationController.getNotifications); // [cite: 89, 93]
router.patch('/:id/read', notificationController.markAsRead);
router.patch('/read-all', notificationController.markAllAsRead);
router.delete('/delete-all', notificationController.deleteAllNotifications);
router.delete('/:id', notificationController.deleteNotification);
module.exports = router;