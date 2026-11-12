import { useId, useState, type FormEvent } from "react";
import { useSaveStatus, useServices } from "./hooks";
import { parseSeed, randomSeed } from "./seed";
import { useUi } from "./store";

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function savedWhen(ms: number): string {
  const date = new Date(ms);
  const today = new Date().toDateString() === date.toDateString();
  return today ? clockTime(ms) : date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function NewCityForm() {
  const { newCity } = useServices();
  const busy = useUi((s) => s.busy);
  const [name, setName] = useState("New city");
  const [seedText, setSeedText] = useState(() => String(randomSeed()));
  const seed = parseSeed(seedText);
  const nameId = useId();
  const seedId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (seed !== null) void newCity(name, seed);
  };

  return (
    <form className="new-city" onSubmit={submit} aria-label="New city">
      <h3>New city</h3>
      <label htmlFor={nameId}>Name</label>
      <input id={nameId} name="name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <label htmlFor={seedId}>Seed</label>
      <div className="row">
        <input
          id={seedId}
          name="seed"
          inputMode="numeric"
          value={seedText}
          aria-invalid={seed === null}
          aria-describedby={`${seedId}-hint`}
          onChange={(e) => setSeedText(e.target.value)}
        />
        <button type="button" onClick={() => setSeedText(String(randomSeed()))}>Random</button>
      </div>
      <p id={`${seedId}-hint`} className="hint">
        {seed === null ? "A seed is a whole number from 0 to 4294967295." : "The same seed always makes the same map."}
      </p>
      <button type="submit" disabled={seed === null || busy}>Start new city</button>
    </form>
  );
}

/** New city, save, saved cities, download and import. */
export function CityMenu() {
  const { saveNow, downloadCity, importCityFile, openCity } = useServices();
  const open = useUi((s) => s.menuOpen);
  const busy = useUi((s) => s.busy);
  const status = useSaveStatus();

  const elsewhere = status?.openElsewhere ?? false;
  const last = status?.lastSave;
  const saveText = !status || elsewhere
    ? "-"
    : last
      ? `tick ${last.tick} at ${clockTime(last.savedAt)} (${last.reason})`
      : `not yet, resumed at tick ${status.loadedTick} from ${status.loadedFrom}`;

  return (
    <section id="city-menu" className="panel city-menu" aria-label="City menu" hidden={!open}>
      <h2>City</h2>
      <dl>
        <dt>Running</dt>
        <dd id="save-city">
          {!status
            ? "loading"
            : elsewhere
              ? `nothing, "${status.city.name}" is open in another tab (${status.cities.length} saved)`
              : `${status.city.name}, seed ${status.city.seed} (${status.cities.length} saved)`}
        </dd>
        <dt>Saved</dt>
        <dd id="save-status">{saveText}</dd>
      </dl>
      <div className="actions">
        <button type="button" disabled={elsewhere} onClick={() => void saveNow()}>Save</button>
        <button id="download-city" type="button" disabled={elsewhere} onClick={() => void downloadCity().catch(() => undefined)}>
          Download
        </button>
        <label className="button">
          Import
          <input
            id="import-file"
            type="file"
            accept=".city"
            disabled={busy}
            onChange={(e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              // Clear it so picking the same file again still fires `change`.
              input.value = "";
              if (file) void importCityFile(file);
            }}
          />
        </label>
      </div>

      <h3>Saved cities</h3>
      <ul className="city-list" aria-label="Saved cities">
        {status?.cities.map((c) => {
          const running = c.id === status.city.id;
          return (
            <li key={c.id}>
              <span className="name">{c.name}</span>
              <span className="meta">
                seed {c.seed}, tick {c.tick}, saved {savedWhen(c.savedAt)}
              </span>
              {running ? (
                <span className="running">{elsewhere ? "open in another tab" : "open now"}</span>
              ) : (
                <button type="button" disabled={busy} aria-label={`Open ${c.name}`} onClick={() => void openCity(c.id)}>
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <NewCityForm />
    </section>
  );
}
