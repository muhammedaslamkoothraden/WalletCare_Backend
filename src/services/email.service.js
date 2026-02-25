const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST,
  port: Number(process.env.BREVO_SMTP_PORT),
  secure: Number(process.env.BREVO_SMTP_PORT) === 465, // auto TLS based on port
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  }
});

// Optional: verify connection on startup
transporter.verify()
  .then(() => console.log("SMTP server ready"))
  .catch((err) => console.error("SMTP configuration error:", err));

exports.sendOtpEmail = async (to, otp) => {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: "Email Verification Code",
      text: `Your verification code is ${otp}. It expires in 10 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>Email Verification</h2>
          <p>Your verification code is:</p>
          <h1 style="letter-spacing: 4px;">${otp}</h1>
          <p>This code will expire in 10 minutes.</p>
        </div>
      `
    });

  } catch (err) {
    console.error("EMAIL ERROR:", err);
    throw new Error("Failed to send verification email");
  }
};