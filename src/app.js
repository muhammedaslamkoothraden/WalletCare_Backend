const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");
const helmet = require("helmet");

// Load environment variables
require("dotenv").config();

const authRoutes = require("./routes/authRoutes");

const app = express();

// Global middlewares
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use("/api/wallet",  walletRoutes);
app.use("/api/transaction", transactionRoutes);
app.use("/api/auth", authRoutes);
 

// Health check
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});



module.exports = app;
