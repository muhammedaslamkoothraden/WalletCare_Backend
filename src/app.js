const express = require("express");
require("dotenv").config();

const cors = require("cors");
const helmet = require("helmet");

const AccountRoutes = require("./routes/Account.routes");
const transactionRoutes = require("./routes/transaction.routes");
const authRoutes = require("./routes/auth.routes");
const goalRoutes = require("./routes/goal.routes");

const authMiddleware = require("./middlewares/auth.middleware");

const app = express();

// Global middlewares
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/account", AccountRoutes);
app.use("/api/transaction", transactionRoutes);
app.use("/api/goals", authMiddleware, goalRoutes);

// Health check
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});

module.exports = app;