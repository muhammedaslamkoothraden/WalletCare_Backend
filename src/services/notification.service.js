const Notification = require("../models/Notification");
// Create a notification for the user
exports.createNotification = async (
  userId,
  message,
  type
) => {

  return await Notification.create({
    userId,
    message,
    type
  });

};