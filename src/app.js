const express = require("express");
require("dotenv").config();

const connectDB = require("./config/db");
const goalRoutes = require("./routes/goal.routes");
const authMiddleware = require("./middlewares/auth");

const app = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(express.json());

// Routes
app.use("/api/goals", authMiddleware, goalRoutes);

// Test route
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});

module.exports = app;
