'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  WalletCare — Export Controller
 *  File: src/controllers/export.controller.js
 *
 *  Generates a professional PDF report containing:
 *    • User info + export date
 *    • Account summary (all accounts + balances)
 *    • Full transaction history (Ledger entries)
 *    • Goals summary (all goals with progress)
 *    • Financial summary (income, expense, net savings)
 *
 *  Install dependency first:
 *    npm install pdfkit
 *
 *  Route (add to your app.js):
 *    const exportRoutes = require('./routes/export.routes');
 *    app.use('/api/export', authMiddleware, exportRoutes);
 *
 *  Flutter usage:
 *    GET /api/export/pdf
 *    GET /api/export/pdf?startDate=2025-01-01&endDate=2025-12-31
 *    GET /api/export/pdf?accountId=<accountId>
 *    Authorization: Bearer <accessToken>
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PDFDocument = require('pdfkit');
const mongoose    = require('mongoose');
const Ledger      = require('../models/Ledger');
const Account     = require('../models/Account');
const Goal        = require('../models/Goal');
const { User }    = require('../models/user');

// ─── Colours (matches WalletCare brand) ──────────────────────────────────────
const COLORS = {
  primary:    '#4F8EF7',   // Blue accent
  success:    '#34C98E',   // Green
  danger:     '#EF4444',   // Red
  warning:    '#F59E0B',   // Yellow/orange
  dark:       '#1A1F36',   // Dark navy
  gray:       '#6B7280',   // Gray
  lightGray:  '#F3F4F6',   // Light gray background
  white:      '#FFFFFF',
  text:       '#1F2937',   // Body text
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a number as Indian currency string e.g. ₹1,234.56 */
function formatCurrency(amount, currency = 'INR') {
  const num = parseFloat(amount) || 0;
  const symbol = currency === 'INR' ? '₹'
    : currency === 'USD' ? '$'
    : currency === 'EUR' ? '€'
    : currency === 'GBP' ? '£'
    : currency === 'AED' ? 'AED '
    : '₹';
  return `${symbol}${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a Date into "DD MMM YYYY" e.g. "27 Apr 2025" */
function formatDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/** Format a Date into "DD MMM YYYY, HH:MM" e.g. "27 Apr 2025, 14:30" */
function formatDateTime(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** Map transaction direction to a human-readable label */
function directionLabel(direction) {
  const labels = {
    STANDARD:             'Standard',
    GOAL_ALLOCATION:      'Goal Deposit',
    GOAL_DEALLOCATION:    'Goal Withdraw',
    GOAL_COMPLETION:      'Goal Achieved',
    ACCOUNT_TRANSFER_IN:  'Transfer In',
    ACCOUNT_TRANSFER_OUT: 'Transfer Out',
    REVERSAL:             'Reversal',
    RESERVED_IN:          'Reserved',
    RESERVED_OUT:         'Released',
  };
  return labels[direction] || direction;
}

/** Hex color → r,g,b array for PDFKit fillColor */
function hex(color) { return color; }

// ─── PDF Builder ─────────────────────────────────────────────────────────────

/**
 * Draws a filled rounded rectangle.
 * PDFKit doesn't have roundRect built-in, so we approximate with a rect.
 */
function drawRect(doc, x, y, w, h, color, opacity = 1) {
  doc.save()
     .fillOpacity(opacity)
     .fillColor(color)
     .rect(x, y, w, h)
     .fill()
     .restore();
}

/** Draw a horizontal rule */
function drawRule(doc, y, color = COLORS.lightGray) {
  doc.save()
     .strokeColor(color)
     .lineWidth(0.5)
     .moveTo(40, y)
     .lineTo(doc.page.width - 40, y)
     .stroke()
     .restore();
}

/** Draw section header bar */
function sectionHeader(doc, title, y) {
  const pageW = doc.page.width;
  drawRect(doc, 40, y, pageW - 80, 24, COLORS.dark);
  doc.font('Helvetica-Bold')
     .fontSize(10)
     .fillColor(COLORS.white)
     .text(title.toUpperCase(), 50, y + 7, { width: pageW - 100 });
  return y + 32;
}

/** Ensure we have enough space on the page, add page if not */
function ensureSpace(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - 60) {
    doc.addPage();
  }
}

// ─── Main Export Handler ──────────────────────────────────────────────────────

exports.exportPDF = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user._id);

    // ── 1. Parse query params ────────────────────────────────────────────────
    const {
      startDate,
      endDate,
      accountId,
    } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate)   dateFilter.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));

    const ledgerMatch = {
      userId,
      status: 'COMPLETED',
      ...(Object.keys(dateFilter).length && { transactedAt: dateFilter }),
      ...(accountId && accountId !== 'all' && {
        accountId: new mongoose.Types.ObjectId(accountId),
      }),
    };

    // ── 2. Fetch all data in parallel ────────────────────────────────────────
    const [user, accounts, transactions, goals] = await Promise.all([
      User.findById(userId).lean(),

      Account.find({ userId, status: { $ne: 'CLOSED' } })
        .sort({ isDefault: -1, createdAt: 1 })
        .lean(),

      Ledger.find(ledgerMatch)
        .populate('accountId', 'name type currency')
        .populate('goalId',    'title')
        .sort({ transactedAt: -1 })
        .lean(),

      Goal.find({ userId }).sort({ status: 1, createdAt: -1 }).lean(),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // ── 3. Compute financial summary ─────────────────────────────────────────
    let totalIncome  = 0;
    let totalExpense = 0;
    const categoryMap = {};

    for (const tx of transactions) {
      const amt = parseFloat(tx.amount?.toString() || '0');
      if (tx.transactionType === 'INCOME')  totalIncome  += amt;
      if (tx.transactionType === 'EXPENSE') totalExpense += amt;
      if (tx.transactionType === 'EXPENSE' && tx.category) {
        categoryMap[tx.category] = (categoryMap[tx.category] || 0) + amt;
      }
    }
    const netSavings = totalIncome - totalExpense;

    // ── 4. Create PDF document ───────────────────────────────────────────────
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      info: {
        Title:   'WalletCare — Transaction History Report',
        Author:  user.name,
        Subject: 'Financial History Export',
      },
    });

    // Pipe to HTTP response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="WalletCare_History_${Date.now()}.pdf"`
    );
    doc.pipe(res);

    const pageW = doc.page.width;
    const contentW = pageW - 80; // 40px margin each side

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 1 — COVER / HEADER
    // ════════════════════════════════════════════════════════════════════════

    // Top banner
    drawRect(doc, 0, 0, pageW, 110, COLORS.dark);

    // App name
    doc.font('Helvetica-Bold')
       .fontSize(26)
       .fillColor(COLORS.primary)
       .text('WalletCare', 40, 28);

    doc.font('Helvetica')
       .fontSize(11)
       .fillColor('#A5B4FC')
       .text('Personal Finance Report', 40, 58);

    // Export date (top right)
    doc.font('Helvetica')
       .fontSize(9)
       .fillColor(COLORS.white)
       .text(`Generated: ${formatDateTime(new Date())}`, 40, 90, { align: 'right', width: contentW });

    let y = 130;

    // ── User Info Card ───────────────────────────────────────────────────────
    drawRect(doc, 40, y, contentW, 60, COLORS.lightGray);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.dark)
       .text(user.name, 55, y + 10);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.gray)
       .text(user.email, 55, y + 27);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.gray)
       .text(
         `Member since ${formatDate(user.createdAt)}   |   ${user.isPremium ? '★ Premium' : 'Free Plan'}`,
         55, y + 42,
       );

    // Report period (right side of card)
    const periodText = startDate || endDate
      ? `${startDate ? formatDate(startDate) : 'All time'} → ${endDate ? formatDate(endDate) : 'Now'}`
      : 'All time';
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.gray)
       .text('REPORT PERIOD', 55, y + 10, { align: 'right', width: contentW - 30 });
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
       .text(periodText, 55, y + 24, { align: 'right', width: contentW - 30 });

    y += 80;

    // ── Financial Summary Cards (3 across) ───────────────────────────────────
    const cardW = (contentW - 20) / 3;
    const cards = [
      { label: 'Total Income',   value: formatCurrency(totalIncome),  color: COLORS.success },
      { label: 'Total Expense',  value: formatCurrency(totalExpense), color: COLORS.danger  },
      { label: 'Net Savings',    value: formatCurrency(netSavings),   color: netSavings >= 0 ? COLORS.primary : COLORS.warning },
    ];

    cards.forEach((card, i) => {
      const cx = 40 + i * (cardW + 10);
      drawRect(doc, cx, y, cardW, 56, COLORS.dark);
      // Colored top bar
      drawRect(doc, cx, y, cardW, 4, card.color);
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.gray)
         .text(card.label, cx + 10, y + 13, { width: cardW - 20 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(card.color)
         .text(card.value, cx + 10, y + 27, { width: cardW - 20 });
    });

    y += 76;

    // Additional stats row
    const statItems = [
      { label: 'Transactions', value: transactions.length.toString() },
      { label: 'Accounts',     value: accounts.length.toString() },
      { label: 'Goals',        value: goals.length.toString() },
      { label: 'Savings Rate', value: totalIncome > 0 ? `${((netSavings / totalIncome) * 100).toFixed(1)}%` : '—' },
    ];
    const statW = contentW / 4;
    statItems.forEach((stat, i) => {
      const sx = 40 + i * statW;
      drawRect(doc, sx, y, statW - 4, 36, COLORS.lightGray);
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.gray)
         .text(stat.label, sx + 8, y + 6, { width: statW - 20 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.dark)
         .text(stat.value, sx + 8, y + 18, { width: statW - 20 });
    });

    y += 56;
    drawRule(doc, y);
    y += 16;

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 1 — ACCOUNTS SUMMARY
    // ════════════════════════════════════════════════════════════════════════

    y = sectionHeader(doc, '1. Account Summary', y);

    if (accounts.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.gray)
         .text('No accounts found.', 40, y);
      y += 20;
    } else {
      // Table header
      const acCols = [
        { label: 'Account Name', x: 40,  w: 130 },
        { label: 'Type',         x: 175, w: 60  },
        { label: 'Currency',     x: 240, w: 55  },
        { label: 'Available',    x: 300, w: 100 },
        { label: 'Reserved',     x: 405, w: 90  },
        { label: 'Status',       x: 500, w: 60  },
      ];

      drawRect(doc, 40, y, contentW, 20, COLORS.dark);
      acCols.forEach(col => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.white)
           .text(col.label, col.x + 4, y + 6, { width: col.w - 4 });
      });
      y += 20;

      accounts.forEach((acc, idx) => {
        ensureSpace(doc, 24);
        if (doc.y > y) y = doc.y;

        const rowBg = idx % 2 === 0 ? COLORS.white : COLORS.lightGray;
        drawRect(doc, 40, y, contentW, 22, rowBg);

        const avail = parseFloat(acc.availableBalance?.toString() || '0');
        const resv  = parseFloat(acc.reservedBalance?.toString()  || '0');

        doc.font(acc.isDefault ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(COLORS.text)
           .text((acc.isDefault ? '★ ' : '') + acc.name, acCols[0].x + 4, y + 6, { width: acCols[0].w - 8, ellipsis: true });
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.gray)
           .text(acc.type, acCols[1].x + 4, y + 6, { width: acCols[1].w });
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.gray)
           .text(acc.currency || 'INR', acCols[2].x + 4, y + 6, { width: acCols[2].w });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(avail >= 0 ? COLORS.text : COLORS.danger)
           .text(formatCurrency(avail, acc.currency), acCols[3].x + 4, y + 6, { width: acCols[3].w });
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.gray)
           .text(formatCurrency(resv, acc.currency), acCols[4].x + 4, y + 6, { width: acCols[4].w });

        const statusColor = acc.status === 'ACTIVE' ? COLORS.success
          : acc.status === 'FROZEN' ? COLORS.warning : COLORS.danger;
        doc.font('Helvetica-Bold').fontSize(8).fillColor(statusColor)
           .text(acc.status, acCols[5].x + 4, y + 7, { width: acCols[5].w });

        y += 22;
      });
    }

    y += 20;

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 2 — TRANSACTION HISTORY
    // ════════════════════════════════════════════════════════════════════════

    ensureSpace(doc, 60);
    if (doc.y > y) y = doc.y;

    y = sectionHeader(doc, `2. Transaction History  (${transactions.length} records)`, y);

    if (transactions.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.gray)
         .text('No transactions found for the selected period.', 40, y);
      y += 20;
    } else {
      // Column layout
      const txCols = [
        { label: 'Date',        x: 40,  w: 85  },
        { label: 'Account',     x: 128, w: 85  },
        { label: 'Category',    x: 216, w: 70  },
        { label: 'Type',        x: 289, w: 65  },
        { label: 'Direction',   x: 357, w: 75  },
        { label: 'Amount',      x: 435, w: 80  },
        { label: 'Balance',     x: 518, w: 50  },
      ];

      // Draw table header
      const drawTxHeader = (yPos) => {
        drawRect(doc, 40, yPos, contentW, 18, COLORS.primary);
        txCols.forEach(col => {
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLORS.white)
             .text(col.label, col.x + 3, yPos + 5, { width: col.w - 4 });
        });
        return yPos + 18;
      };

      y = drawTxHeader(y);

      transactions.forEach((tx, idx) => {
        // New page check — re-draw header on new pages
        if (y + 22 > doc.page.height - 50) {
          doc.addPage();
          y = 40;
          y = sectionHeader(doc, `2. Transaction History (continued)`, y);
          y = drawTxHeader(y);
        }

        const rowBg = idx % 2 === 0 ? COLORS.white : COLORS.lightGray;
        drawRect(doc, 40, y, contentW, 22, rowBg);

        const amt      = parseFloat(tx.amount?.toString() || '0');
        const running  = tx.runningBalance ? parseFloat(tx.runningBalance.toString()) : null;
        const isIncome = tx.transactionType === 'INCOME';
        const isDebit  = ['EXPENSE', 'TRANSFER'].includes(tx.transactionType);
        const amtColor = isIncome ? COLORS.success : isDebit ? COLORS.danger : COLORS.gray;
        const amtPrefix = isIncome ? '+' : isDebit ? '-' : '';
        const currency  = tx.accountId?.currency || 'INR';

        doc.font('Helvetica').fontSize(8).fillColor(COLORS.gray)
           .text(formatDate(tx.transactedAt), txCols[0].x + 3, y + 7, { width: txCols[0].w });
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.text)
           .text(tx.accountId?.name || '—', txCols[1].x + 3, y + 7, { width: txCols[1].w - 4, ellipsis: true });
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.text)
           .text(tx.category || '—', txCols[2].x + 3, y + 7, { width: txCols[2].w - 4, ellipsis: true });
        doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.gray)
           .text(tx.transactionType, txCols[3].x + 3, y + 7, { width: txCols[3].w });
        doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.gray)
           .text(directionLabel(tx.direction), txCols[4].x + 3, y + 7, { width: txCols[4].w });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(amtColor)
           .text(`${amtPrefix}${formatCurrency(amt, currency)}`, txCols[5].x + 3, y + 7, { width: txCols[5].w });
        if (running !== null) {
          doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.gray)
             .text(formatCurrency(running, currency), txCols[6].x + 3, y + 7, { width: txCols[6].w });
        }

        y += 22;
      });

      // Category breakdown mini-table
      if (Object.keys(categoryMap).length > 0) {
        ensureSpace(doc, 100);
        if (doc.y > y) y = doc.y;

        y += 16;
        doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.dark)
           .text('Top Spending Categories', 40, y);
        y += 18;

        const sortedCats = Object.entries(categoryMap)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8);

        const barMaxW = 220;
        const maxAmt  = sortedCats[0][1];

        sortedCats.forEach(([cat, amt], i) => {
          ensureSpace(doc, 22);
          drawRect(doc, 40, y, 100, 16, COLORS.lightGray);
          doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text)
             .text(cat, 46, y + 4, { width: 90 });
          const barW = Math.max(4, (amt / maxAmt) * barMaxW);
          drawRect(doc, 146, y, barW, 16, COLORS.primary, 0.6);
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.dark)
             .text(formatCurrency(amt), 150 + barMaxW + 8, y + 4);
          y += 20;
        });
      }
    }

    y += 20;

    // ════════════════════════════════════════════════════════════════════════
    // SECTION 3 — GOALS SUMMARY
    // ════════════════════════════════════════════════════════════════════════

    ensureSpace(doc, 60);
    if (doc.y > y) y = doc.y;

    y = sectionHeader(doc, `3. Goals Summary  (${goals.length} goals)`, y);

    if (goals.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.gray)
         .text('No goals found.', 40, y);
      y += 20;
    } else {
      const glCols = [
        { label: 'Goal Title',  x: 40,  w: 130 },
        { label: 'Category',    x: 174, w: 80  },
        { label: 'Target',      x: 257, w: 85  },
        { label: 'Saved',       x: 345, w: 85  },
        { label: 'Progress',    x: 433, w: 80  },
        { label: 'Status',      x: 516, w: 60  },
      ];

      drawRect(doc, 40, y, contentW, 18, COLORS.dark);
      glCols.forEach(col => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.white)
           .text(col.label, col.x + 3, y + 5, { width: col.w - 4 });
      });
      y += 18;

      goals.forEach((goal, idx) => {
        ensureSpace(doc, 26);
        if (doc.y > y) y = doc.y;

        const rowBg = idx % 2 === 0 ? COLORS.white : COLORS.lightGray;
        drawRect(doc, 40, y, contentW, 26, rowBg);

        const progress = goal.targetAmount > 0
          ? Math.min(100, (goal.currentAmount / goal.targetAmount) * 100)
          : 0;

        const statusColor = goal.status === 'completed' ? COLORS.success
          : goal.status === 'overdue' ? COLORS.danger : COLORS.primary;

        doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text)
           .text(goal.title, glCols[0].x + 4, y + 5, { width: glCols[0].w - 8, ellipsis: true });
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.gray)
           .text(`Due: ${formatDate(goal.targetDate)}`, glCols[0].x + 4, y + 16, { width: glCols[0].w - 8 });

        doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text)
           .text(goal.category, glCols[1].x + 3, y + 9, { width: glCols[1].w });

        doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text)
           .text(formatCurrency(goal.targetAmount), glCols[2].x + 3, y + 9, { width: glCols[2].w });

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.success)
           .text(formatCurrency(goal.currentAmount), glCols[3].x + 3, y + 9, { width: glCols[3].w });

        // Progress bar
        const pbW = 70;
        const pbFill = Math.max(2, (progress / 100) * pbW);
        drawRect(doc, glCols[4].x + 3, y + 9,  pbW, 8, '#E5E7EB');
        drawRect(doc, glCols[4].x + 3, y + 9, pbFill, 8, statusColor);
        doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.gray)
           .text(`${progress.toFixed(0)}%`, glCols[4].x + 3, y + 18, { width: pbW });

        doc.font('Helvetica-Bold').fontSize(8).fillColor(statusColor)
           .text(goal.status.toUpperCase(), glCols[5].x + 3, y + 9, { width: glCols[5].w });

        y += 26;
      });
    }

    y += 20;

    // ════════════════════════════════════════════════════════════════════════
    // FOOTER — every page
    // ════════════════════════════════════════════════════════════════════════

    const pageCount = doc.bufferedPageRange().count || 1;

    // Add footer to all pages
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      const footerY = doc.page.height - 35;

      drawRect(doc, 0, footerY, pageW, 35, COLORS.dark);

      doc.font('Helvetica').fontSize(8).fillColor(COLORS.gray)
         .text('WalletCare — Confidential Financial Report', 40, footerY + 12, { width: contentW / 2 });

      doc.font('Helvetica').fontSize(8).fillColor(COLORS.gray)
         .text(
           `Page ${i + 1} of ${pageCount}  |  ${formatDate(new Date())}`,
           40, footerY + 12,
           { width: contentW, align: 'right' },
         );
    }

    doc.end();

  } catch (error) {
    console.error('[exportPDF] error:', error.message);
    // Only send error if headers haven't been sent yet
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
};