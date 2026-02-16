const express = require("express");
const connectDB = require("./config/db");
const devwallet = require('./routes/dev.wallet.routes');
const wallet =  require('./routes/wallet.routes');
// Load environment variables
require("dotenv").config();

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(express.json());
app.use(  "/api/dev/wallet", devwallet);
app.use("/api/wallet", wallet);

// Example route
app.get("/", (req, res) => {
  res.send("WalletCare API is running...");
});


module.exports = app;
