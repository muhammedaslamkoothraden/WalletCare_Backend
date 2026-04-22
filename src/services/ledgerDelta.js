function computeBalanceDelta(direction, transactionType, rawAmount) {
  const amount = new Decimal(rawAmount.toString());
  const zero = new Decimal(0);

  switch (direction) {
    case 'STANDARD':
    case 'EDIT_REPLACEMENT':
      return {
        balanceChange: transactionType === 'INCOME' ? amount : amount.negated(),
        reservedChange: zero,
      };

    case 'GOAL_ALLOCATION':
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'GOAL_DEALLOCATION':
      return { balanceChange: amount, reservedChange: zero };

    case 'ACCOUNT_TRANSFER_IN':
      return { balanceChange: amount, reservedChange: zero };

    case 'ACCOUNT_TRANSFER_OUT':
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'RESERVED_IN':
      return { balanceChange: amount.negated(), reservedChange: amount };

    case 'RESERVED_OUT':
      return { balanceChange: amount, reservedChange: amount.negated() };

    default:
      throw new Error(`Unrecognized direction in computeBalanceDelta: '${direction}'`);
  }
}