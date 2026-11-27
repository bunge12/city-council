// Settings for the UI shell. Host and display numbers, not game balance.

/** Worker time one tick may take, in ms. The debug panel measures against it. See M0.md. */
export const TICK_BUDGET_MS = 20;

/**
 * Game days the milestone notice stays up before it goes by itself (M4-14).
 * Game time, read from the copy's tick, so a paused city keeps it until it
 * is closed and a slow machine shows it as long as a fast one.
 */
export const MILESTONE_NOTICE_DAYS = 3;
