require("dotenv").config();

const app = require("./app");
const connectDB = require("./config/db");

// Background jobs
require("./jobs/cron");
const { startDeletionJob } = require("./jobs/delete.job");

// Connect to MongoDB
connectDB();

// Start background jobs
startDeletionJob();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
