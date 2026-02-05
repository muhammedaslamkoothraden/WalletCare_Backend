const express = require("express");
const connectDB = require("./config/db");

// Load environment variables
require("dotenv").config();

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(express.json());

// Example route
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});

module.exports = app;
