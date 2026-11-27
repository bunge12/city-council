import { useServices, useSim } from "./hooks";
import { formatLogAmount } from "./money-figures";
import { usePanelOrder, useUi } from "./store";

/** How many of the latest entries the log view lists. */
export const LOG_VIEW_ROWS = 50;

function payloadText(payload: unknown): string {
  if (payload === undefined) return "";
  const text = JSON.stringify(payload);
  return text === "{}" ? "" : text;
}

/** Recent commands the sim applied, newest first, and a button that sends a NoOp. */
export function ActivityLog() {
  const { mirror, sendCommand } = useServices();
  const open = useUi((s) => s.logOpen);
  const lastCommand = useUi((s) => s.lastCommand);
  // The total only grows, so it is the version of the log to re-render on.
  const total = useSim((s) => (s ? s.logOffset + s.log.length : 0));
  const log = mirror.state?.log ?? [];
  // What each entry's command moved, beside it and paged with it (M4-03).
  const spent = mirror.state?.logSpent ?? [];
  const rows = log.slice(-LOG_VIEW_ROWS).map((entry, i, shown) => ({ entry, spent: spent[log.length - shown.length + i] })).reverse();

  const order = usePanelOrder("log");
  return (
    <section id="activity-log" className="panel activity-log" aria-label="Activity log" hidden={!open} style={{ order }}>
      <h2>Activity log</h2>
      <div className="actions">
        <button type="button" onClick={() => void sendCommand("NoOp")}>Send NoOp</button>
        <span>
          Last command: <span id="sim-last-result">{lastCommand ?? "none"}</span>
        </span>
      </div>
      <p className="hint">
        {total === 0 ? "No commands yet." : `${total} applied, showing the latest ${Math.min(total, LOG_VIEW_ROWS)}.`}
      </p>
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Tick</th>
              <th scope="col">Player</th>
              <th scope="col">Command</th>
              <th scope="col" title="What the command took from the treasury, or + for what it paid in">Money</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, spent }, i) => (
              <tr key={total - i} data-seq={entry.seq} data-spent={spent ?? ""}>
                <td className="num">{entry.tick}</td>
                <td>{entry.playerId}</td>
                <td>
                  {entry.type} <span className="payload">{payloadText(entry.payload)}</span>
                </td>
                <td className="num money">{formatLogAmount(spent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
