const express = require("express");
const router = express.Router();

const notificationController =
    require("../controllers/notification.controller");

const authMiddleware =
    require("../middlewares/auth.middleware");

router.get("/", authMiddleware, notificationController.getUserNotifications);

module.exports = router;