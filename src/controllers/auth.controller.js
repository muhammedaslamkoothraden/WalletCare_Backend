const { User, PendingUser } = require("../models/user");
const { createOtp, resendOtp } = require("../services/otp.service");
const bcrypt = require("bcryptjs");

//Register
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Block if already a verified user
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "An account with this email already exists" });
    }

    const existingPending = await PendingUser.findOne({ email: normalizedEmail });

    if (existingPending) {
      // Always update pending record with latest submitted data
      const hashedPassword = await bcrypt.hash(password, 10);
      await PendingUser.findOneAndUpdate(
        { email: normalizedEmail },
        { name, password: hashedPassword, phone },
        { new: true }
      );

      try {
        await resendOtp(normalizedEmail, "signup");
        return res.status(200).json({ message: "A verification OTP has been sent to your email" });

      } catch (resendError) {
        // OTP expired — create fresh lifecycle with already updated pending record
        if (resendError.message === "OTP_EXPIRED") {
          await createOtp(normalizedEmail, "signup");
          return res.status(200).json({ message: "A verification OTP has been sent to your email" });
        }

        if (resendError.message === "COOLDOWN_ACTIVE") {
          return res.status(429).json({ message: "Please wait 60 seconds before requesting another OTP" });
        }

        if (resendError.message === "RESEND_LIMIT_REACHED") {
          return res.status(429).json({ message: "Maximum resend attempts reached. Please wait for the OTP to expire" });
        }

        throw resendError;
      }
    }

    // Fresh registration
    const hashedPassword = await bcrypt.hash(password, 10);

    await PendingUser.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      phone,
      role: "user"
    });

    await createOtp(normalizedEmail, "signup");

    return res.status(201).json({ message: "Registration successful. Please verify your email" });

  } catch (error) {
    console.error("registerUser error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

//Login
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // select("+password") needed because password field has select: false in schema
    const user = await User.findOne({ email: normalizedEmail }).select("+password");
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({ message: "Please verify your email before logging in" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // userId is temporary — will be replaced with JWT token in next milestone
    return res.status(200).json({
      message: "Login successful",
      userId: user._id
    });

  } catch (error) {
    console.error("loginUser error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};