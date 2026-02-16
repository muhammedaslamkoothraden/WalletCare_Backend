const express = require("express");
const connectDB = require("./config/db");
const devwallet = require('./routes/dev.wallet.routes');
const walletRoutes =  require('./routes/wallet.routes');
const transactionRoutes = require('./routes/transaction.routes');
// Load environment variables
require("dotenv").config();

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(express.json());
app.use(  "/api/dev/wallet", devwallet);
app.use("/api/wallet",  walletRoutes);
app.use("/api/transaction", transactionRoutes);

// Example route
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});


module.exports = app;
