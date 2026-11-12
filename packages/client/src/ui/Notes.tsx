import { EXPORT_REMINDER_INTERVAL_MS } from "../save/config";
import { wantsExportReminder } from "../save/city-file";
import { useEffect, useState } from "react";
import { useSaveStatus, useServices } from "./hooks";
import { useUi } from "./store";

function Note({ id, text, problem = false }: { id: string; text: string | null; problem?: boolean }) {
  return (
    <p id={id} className={problem ? "note problem" : "note"} role={problem ? "alert" : "status"} hidden={text === null}>
      {text}
    </p>
  );
}

/** Wall time, re-read every minute so the reminder can appear while the page is open. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Messages to the player about saving, storage and city files. */
export function Notes() {
  const { downloadCity } = useServices();
  const status = useSaveStatus();
  const fileNote = useUi((s) => s.fileNote);
  const fileProblem = useUi((s) => s.fileProblem);
  const storageNote = useUi((s) => s.storageNote);
  const dismissed = useUi((s) => s.reminderDismissed);
  const now = useMinuteClock();

  const saveProblem = status ? [status.problem, status.saveError].filter(Boolean).join(" ") || null : null;
  const city = status?.cities.find((c) => c.id === status.city.id);
  // A save status that arrives after the minute tick still counts from now.
  const reminder = !dismissed && city !== undefined && wantsExportReminder(city, Math.max(now, Date.now()), EXPORT_REMINDER_INTERVAL_MS);

  return (
    <section className="notes" aria-label="Notes">
      <Note id="save-problem" text={saveProblem} problem />
      <Note id="storage-note" text={storageNote} />
      <Note id="file-problem" text={fileProblem} problem />
      <Note id="file-note" text={fileNote} />
      <div id="export-reminder" className="note" role="status" hidden={!reminder}>
        <span>
          {city
            ? `You have not downloaded a copy of "${city.name}" for a while. ` +
              "The browser can clear saved cities, so a file is the copy to keep."
            : null}
        </span>
        <div className="actions">
          <button type="button" onClick={() => void downloadCity().catch(() => undefined)}>Download a copy</button>
          <button type="button" onClick={() => useUi.setState({ reminderDismissed: true })}>Not now</button>
        </div>
      </div>
    </section>
  );
}
