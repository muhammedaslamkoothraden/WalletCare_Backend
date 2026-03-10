const Notification = require("../models/Notification");

exports.getUserNotifications = async (req, res) => {

  const notifications = await Notification.find({
    userId: req.user.id
  }).sort({ createdAt: -1 });

  res.json({
    success: true,
    data: notifications
  });

};