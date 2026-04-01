const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const authRoutes = require("./routes/auth.routes");
const otpRoutes = require("./routes/otp.routes");
const userRoutes = require("./routes/user.routes");
const AccountRoutes = require("./routes/Account.routes");
const transactionRoutes = require("./routes/transaction.routes");
const goalRoutes = require("./routes/goal.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const notificationRoutes = require("./routes/notification.routes");
const feedbackRoutes = require("./routes/feedback.routes");

const adminRoutes = require("./routes/admin.routes");
const authMiddleware = require("./middlewares/auth.middleware");

const app = express();

// Global middlewares
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});

// Public routes
app.use("/api/auth", authRoutes);
app.use("/api/otp", otpRoutes);

// Protected routes
app.use("/api/user", authMiddleware, userRoutes);
app.use("/api/account", authMiddleware, AccountRoutes);
app.use("/api/transaction", authMiddleware, transactionRoutes);
app.use("/api/goals", authMiddleware, goalRoutes);
app.use("/api/analytics", authMiddleware, analyticsRoutes);
app.use("/api/notifications", authMiddleware, notificationRoutes);
app.use("/api/feedback", authMiddleware, feedbackRoutes);

// Admin routes
app.use("/api/admin", adminRoutes);

module.exports = app;