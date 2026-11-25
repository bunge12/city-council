# M4-11: Borrowing

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 05.

## Goal

The city can borrow for something it cannot pay for from cash, up to a limit that grows with it. See "Borrowing" in the PRD.

## Scope

- Loans in state: up to the number in `economy.json` open at once, each with its principal, rate, term in months, balance and monthly repayment
- A `TakeLoan` command with a principal and one of the terms the file offers. The rate comes from the file. It is refused past the credit limit or with every slot taken
- A `RepayLoan` command that pays a loan off early from the treasury, refused if the treasury cannot cover it
- The credit limit: weights in the file on population and on last year's tax income, read from the statistics history
- On the budget close each loan charges its repayment. Interest goes on the interest line and the rest on the repayment line. Principal taken goes on the loans line
- The fixed monthly repayment is worked out by repeated multiplication, with no `Math.pow`, and the last payment takes what remains so the balance ends at exactly zero
- A repayment the treasury cannot cover is still charged, since a debt does not wait. It can take the treasury below the overdraft, and spending stays blocked until it recovers
- Loans go in the delta. `SNAPSHOT_VERSION` and the protocol version go up, with a migration and a test

## Out of scope

- The loan section of the budget panel, which is issue 15
- Larger loans unlocked by milestones. Issue 12 adds them through the limit's weights

## Done when

- [ ] Unit tests take a loan, run it to its term and find the balance at exactly zero and the payments equal to principal plus interest
- [ ] A test finds `TakeLoan` refused past the limit and past the slot count, with reasons
- [ ] A test repays a loan early and finds it closed and the treasury down by its balance
- [ ] A replay gives the same state hash

## Notes

Rule 6 applies. The repayment has to come out the same on a server and in a worker, so interest is `Math.floor` of balance times rate, and nothing uses `Math.pow`.

A 10 km subway at honest prices costs about a year of a large city's budget. That is the loan this is for, in M7.
