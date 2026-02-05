---

   WalletCare - Backend Base

Foundational REST API infrastructure for the WalletCare multi-wallet platform

This repository contains the core configuration and modular file structure for the WalletCare backend. It is designed to be scalable, using a clear separation of concerns to allow our team of 3 developers to work in parallel.

---
   # Current Tech Stack

* Runtime: `Node.js` (LTS)
* Framework: `Express.js`
* Database: `MongoDB Atlas` (via Mongoose)
* Environment: `Dotenv` for secure configuration

---

 📂 File Structure Overview

The project uses a modular architecture to separate data models, route handlers, and business logic:

* `config/`: Database connection logic (`db.js`).
* `controllers/`: Logical processing for each feature.
* `models/`: Mongoose schemas (e.g., `user.js`).
* `middlewares/`: Custom request filters and security guards.
* `routes/`: API endpoint definitions.
* `app.js`: Express app configuration and middleware setup.
* `server.js`: Server entry point and port listener.

---

 # Local Setup Instructions

 # 1. Clone & Install

```bash
npm install

```

# 2. Configuration

Create a `.env` file in the root directory. You can reference the `.env.example` for the required keys:

```bash
cp .env.example .env

```

* Required keys: `PORT`, `MONGO_URI`.

# 3. Start Development

The project is configured with `nodemon` for automatic restarts:

```bash
npm run dev

```

---

# Team Standards

* Security: Never commit the `.env` file. It is currently managed via `.gitignore`.
* Branching: No direct pushes to `master`. All work must be done on feature-specific branches.
* Architecture:New features must follow the established `Route -> Controller -> Model` pattern.

---

# Backend Development Team

* Developer 1: Authentication & User Security.
* Developer 2: Wallet Logic & Transaction Ledger.
* Developer 3: Goals Tracking & Repository Management.

---

