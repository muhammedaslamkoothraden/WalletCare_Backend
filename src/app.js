const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

// Route Imports
const authRoutes = require("./routes/auth.routes");
const otpRoutes = require("./routes/otp.routes");
const userRoutes = require("./routes/user.routes");
const accountRoutes = require("./routes/Account.routes");
const transactionRoutes = require("./routes/transaction.routes");
const goalRoutes = require("./routes/goal.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const feedbackRoutes = require("./routes/feedback.routes");
const notificationRoutes = require("./routes/notification.routes");
const testRoutes = require("./routes/test.routes");

const adminRoutes = require("./routes/admin.routes");
const authMiddleware = require("./middlewares/auth.middleware");

const app = express();

// Allowed origins
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
];

// Global middlewares
app.use(helmet());
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Added for form-data support

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({ status: "success", message: "WalletCare API is running..." });
});

// Public API
app.use("/api/auth", authRoutes);
app.use("/api/otp", otpRoutes);

// Protected API (Apply middleware once to a group if possible, or per route)
app.use("/api/user", authMiddleware, userRoutes);
app.use("/api/account", authMiddleware, accountRoutes);
app.use("/api/transaction", authMiddleware, transactionRoutes);
app.use("/api/goals", authMiddleware, goalRoutes);
app.use("/api/analytics", authMiddleware, analyticsRoutes);
app.use("/api/feedback", authMiddleware, feedbackRoutes);
app.use("/api/notifications", authMiddleware, notificationRoutes);
app.use("/api/test", testRoutes);

// ─── ERROR HANDLING ──────────────────────────────────────────────────────────

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Global Error Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    message: "Internal Server Error",
    error: process.env.NODE_ENV === "development" ? err.message : {},
  });
});

// Admin routes
app.use("/api/admin", adminRoutes);

module.exports = app;