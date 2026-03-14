const express = require("express");
require("dotenv").config();

const cors = require("cors");
const helmet = require("helmet");

const authRoutes = require("./routes/auth.routes");
const otpRoutes = require("./routes/otp.routes");
const userRoutes = require("./routes/user.routes");
const AccountRoutes = require("./routes/Account.routes");
const transactionRoutes = require("./routes/transaction.routes");
const goalRoutes = require("./routes/goal.routes");

const authMiddleware = require("./middlewares/auth.middleware");
const { startDeletionJob } = require("./jobs/delete.job");

const app = express();

// global middlewares
app.use(helmet());           // secure HTTP headers
app.use(cors());             // allow all origins for now — restrict in Week 12
app.use(express.json());

// public routes — no auth required
app.use("/api/auth", authRoutes);
app.use("/api/otp", otpRoutes);

// protected routes — auth required
app.use("/api/user", authMiddleware, userRoutes);
app.use("/api/account", authMiddleware, AccountRoutes);
app.use("/api/transaction", authMiddleware, transactionRoutes);
app.use("/api/goals", authMiddleware, goalRoutes);

// start background jobs
startDeletionJob();

// health check
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});

module.exports = app;