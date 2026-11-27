import { MILESTONES, TIME_BALANCE, formatMoneyShort, unlockName, type Milestone } from "@city-council/sim";
import { MILESTONE_NOTICE_DAYS } from "./config";
import { useSim } from "./hooks";
import { useUi } from "./store";

/** Ticks the notice stays up. */
const NOTICE_TICKS = MILESTONE_NOTICE_DAYS * TIME_BALANCE.ticksPerDay;

/** One milestone as the notice gives it: its name, its population and grant, and what it opened. */
export function milestoneLines(m: Milestone): { title: string; detail: string } {
  const unlocks = m.unlocks.map(unlockName);
  const opened = unlocks.length === 0 ? "" : ` Unlocked: ${unlocks.length === 1 ? unlocks[0] : `${unlocks.slice(0, -1).join(", ")} and ${unlocks.at(-1)}`}.`;
  return {
    title: `${m.name} reached`,
    detail: `${m.population.toLocaleString("en-US")} residents. Grant of ${formatMoneyShort(m.grant)} paid.${opened}`,
  };
}

/**
 * A short notice over the time card when the city reaches a milestone in
 * play (M4-14): its name, its grant and what it unlocked. It goes by itself
 * a few game days later, or on its button. One the city already had makes
 * none (milestone-watch.ts).
 */
export function MilestoneNotice() {
  const notice = useUi((s) => s.milestoneNotice);
  // Only whether it has run out, so the notice does not re-render every tick.
  const over = useSim((s) => notice !== null && s !== null && s.tick >= notice.tick + NOTICE_TICKS);
  if (!notice || over) return null;
  const milestones = notice.milestones.map((i) => MILESTONES[i]).filter((m): m is Milestone => m !== undefined);
  if (milestones.length === 0) return null;
  return (
    <section className="panel milestone-notice" id="milestone-notice" role="status" aria-label="Milestone reached" data-milestones={notice.milestones.join(",")}>
      {milestones.map((m) => {
        const { title, detail } = milestoneLines(m);
        return (
          <div className="milestone" key={m.name}>
            <h2>{title}</h2>
            <p>{detail}</p>
          </div>
        );
      })}
      <button type="button" className="close" aria-label="Close" title="Close" onClick={() => useUi.setState({ milestoneNotice: null })}>
        ×
      </button>
    </section>
  );
}
