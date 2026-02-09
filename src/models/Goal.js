const mongoose = require("mongoose");

const goalSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },
        targetAmount: {
            type: Number,
            required: true,
            min: 1,
        },
        currentAmount: {
            type: Number,
            default: 0,
        },
        targetDate: {
            type: Date,
            required: true,
        },
        status: {
            type: String,
            enum: ["active", "completed"],
            default: "active",
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Goal", goalSchema);
