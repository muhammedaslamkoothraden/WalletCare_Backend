const User = require("../models/user");
const { initializeWalletForUser } = require("../services/wallet.service");


// Register logic
exports.registerUser = async (req, res) => {
  try {
    // Extract user data from request body
    const { email, password, phone } = req.body;

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already exists" });
    }

    // Create new user
    // Password will be automatically hashed by pre-save hook in User model
    const user = await User.create({ email, password, phone });
    // 2. Auto-initialize wallet 
    await initializeWalletForUser(user._id);

    // Send success response (do NOT return password)
    res.status(201).json({
      message: "User created successfully",
      userId: user._id
    });

  } catch (error) {
    // Log error internally (do not expose sensitive details to client)
    console.error("Register Error:", error);
    res.status(500).json({ message: "Server error" });
  }
};


// Login logic
exports.loginUser = async (req, res) => {
  try {
    // Extract login data from request body
    const { email, password } = req.body;

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Select password explicitly because select: false
    const user = await User.findOne({ email }).select("+password");

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Use model method
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.status(200).json({
      message: "Login successful",
      userId: user._id
    });

  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
