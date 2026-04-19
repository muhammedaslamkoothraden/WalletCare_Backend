function computeBalanceDelta(direction, transactionType, rawAmount) {
  // 🎯 THE FIX: Force the raw input into a safe decimal.js instance
  const amount = new Decimal(rawAmount.toString());
  const zero = new Decimal(0);

  switch (direction) {
    case 'STANDARD':
    case 'EDIT_REPLACEMENT': {
      return {
        balanceChange: transactionType === 'INCOME' ? amount : amount.negated(),
        reservedChange: zero,
      };
    }

    // ─── RESERVED BALANCE LOGIC ───
    case 'RESERVED_IN': 
      return { balanceChange: amount.negated(), reservedChange: amount };

    case 'RESERVED_OUT': 
      return { balanceChange: amount, reservedChange: amount.negated() };

    // ─── GOAL LOGIC (No connection to Reserved) ───
    case 'GOAL_ALLOCATION':
      // Money leaves available balance to sit in a virtual goal. Reserved is untouched.
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'GOAL_DEALLOCATION':
      // Money returns to available balance from a virtual goal. Reserved is untouched.
      return { balanceChange: amount, reservedChange: zero };

    case 'GOAL_COMPLETION':
      // If Goal Completion doesn't touch balances, just return zeros.
      // (Or update this if completing a goal does something specific in your app)
      return { balanceChange: zero, reservedChange: zero };

    // ─── ACCOUNT TRANSFERS ───
    case 'ACCOUNT_TRANSFER_OUT':
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'ACCOUNT_TRANSFER_IN':
      return { balanceChange: amount, reservedChange: zero };

    default:
      throw new Error(`Unrecognized direction in computeBalanceDelta: '${direction}'`);
  }
}