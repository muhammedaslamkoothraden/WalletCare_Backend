const express = require("express");
require("dotenv").config();

const connectDB = require("./config/db");
const cors = require("cors");
const helmet = require("helmet");

const walletRoutes = require("./routes/wallet.routes");
const transactionRoutes = require("./routes/transaction.routes");
const authRoutes = require("./routes/authRoutes");
const goalRoutes = require("./routes/goal.routes");

const authMiddleware = require("./middlewares/auth");

const app = express();



// Global middlewares
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/transaction", transactionRoutes);
app.use("/api/goals", authMiddleware, goalRoutes);

// Health check
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});

module.exports = app;
