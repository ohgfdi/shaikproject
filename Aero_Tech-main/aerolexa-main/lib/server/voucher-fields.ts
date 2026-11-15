/** Derived columns stored alongside a voucher so the balance check is cheap. */
export function voucherTotals(lines: readonly { amount: number }[]): { totalDebit: number; totalCredit: number } {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    if (line.amount > 0) totalDebit += line.amount;
    else totalCredit += -line.amount;
  }
  return { totalDebit, totalCredit };
}
