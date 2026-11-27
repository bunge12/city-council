import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  ECONOMY,
  debtOf,
  formatMoneyFull,
  formatMoneyShort,
  gameDate,
  loansOf,
  monthlyRepayment,
  type CommandResult,
  type Loan,
} from "@city-council/sim";
import {
  CHARGE_SLIDERS,
  TAX_SLIDERS,
  TAX_STEP,
  budgetTable,
  formatCharge,
  formatRate,
  moneyMonths,
  moneyTicks,
  monthColumns,
  monthLabel,
  taxRateOfSlider,
  type BudgetGroup,
  type BudgetRow,
  type MoneyMonth,
  type MonthPair,
} from "./budget-table";
import { useServices, useSim, type MirrorState } from "./hooks";
import { toggleBudget, usePanelOrder, useUi } from "./store";

// The budget panel (issue M4-15, PRD "M4 Economy"): where the money comes
// from and where it goes, last month and this month so far, a year of it
// on a graph, the tax and development charge sliders, and the loans, each
// on a tab of its own so the panel stays short. It reads the mirror and
// sends commands. Every figure is the sim's: a ledger line, the history,
// or one of the sim's own functions over the copy.

/** A figure in short form, with its whole dollars on hover. Nothing is a dash, so a line that moved nothing reads as such. */
function Money({ value, signed = false }: { value: number; signed?: boolean }) {
  const text = signed && value > 0 ? `+${formatMoneyShort(value)}` : formatMoneyShort(value);
  return <span title={formatMoneyFull(value)}>{text}</span>;
}

// --- The ledger ------------------------------------------------------------------

function LedgerRow({ row, indent }: { row: BudgetRow; indent: boolean }) {
  const quiet = row.last === 0 && row.now === 0;
  return (
    <tr data-line={row.line} data-last={row.last} data-now={row.now} className={quiet ? "quiet" : undefined}>
      <th scope="row" className={indent ? "indent" : undefined}>{row.label}</th>
      <td><Money value={row.last} /></td>
      <td><Money value={row.now} /></td>
    </tr>
  );
}

function Groups({ groups }: { groups: BudgetGroup[] }) {
  return (
    <>
      {groups.map((group) => [
        group.heading && (
          <tr key={`h-${group.heading}`} className="group">
            <th scope="rowgroup" colSpan={3}>{group.heading}</th>
          </tr>
        ),
        ...group.rows.map((row) => <LedgerRow key={row.line} row={row} indent={group.heading !== null} />),
      ])}
    </>
  );
}

function TotalRow({ id, label, pair, signed = false }: { id: string; label: string; pair: MonthPair; signed?: boolean }) {
  return (
    <tr id={id} className="total" data-last={pair.last} data-now={pair.now}>
      <th scope="row">{label}</th>
      <td><Money value={pair.last} signed={signed} /></td>
      <td><Money value={pair.now} signed={signed} /></td>
    </tr>
  );
}

function Ledger({ s }: { s: NonNullable<MirrorState> }) {
  const table = budgetTable(s.budget);
  const columns = monthColumns(s.tick);
  return (
    <table className="budget-ledger" id="budget-ledger">
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">{columns.last}</th>
          <th scope="col">{columns.now}</th>
        </tr>
      </thead>
      <tbody>
        <tr className="section"><th scope="rowgroup" colSpan={3}>Income</th></tr>
        <Groups groups={table.income} />
        <TotalRow id="budget-income" label="Total income" pair={table.totalIncome} />
      </tbody>
      <tbody>
        <tr className="section"><th scope="rowgroup" colSpan={3}>Expenses</th></tr>
        <Groups groups={table.expenses} />
        <TotalRow id="budget-expenses" label="Total expenses" pair={table.totalExpenses} />
      </tbody>
      <tbody>
        <TotalRow id="budget-net" label="Net" pair={table.net} signed />
      </tbody>
    </table>
  );
}

// --- The graph -------------------------------------------------------------------

/** Each chart's size in SVG units; it scales to the panel's width. */
const W = 336;
const H = 120;
const PAD = { left: 44, right: 58, top: 8, bottom: 18 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
/** Income and expenses: categorical slots 1 and 2, checked with the dataviz validator. The treasury is the statistics line's colour. */
const COLOURS = { income: "var(--money-income)", expenses: "var(--money-expenses)", treasury: "var(--stat-line)" } as const;

interface Chart {
  xOf(k: number): number;
  yOf(v: number): number;
  ticks: number[];
}

function chartOf(values: number[], n: number): Chart {
  const ticks = moneyTicks(Math.min(0, ...values), Math.max(0, ...values));
  const bottom = ticks[0] ?? 0;
  const top = ticks.at(-1) ?? 1;
  const slots = Math.max(1, n - 1);
  return {
    xOf: (k) => (n === 1 ? PAD.left + PLOT_W / 2 : PAD.left + (PLOT_W * k) / slots),
    yOf: (v) => PAD.top + PLOT_H * (1 - (v - bottom) / (top - bottom || 1)),
    ticks,
  };
}

function pathOf(chart: Chart, values: number[]): string {
  return values.map((v, k) => `${k === 0 ? "M" : "L"}${chart.xOf(k).toFixed(1)},${chart.yOf(v).toFixed(1)}`).join("");
}

/** Line height of the direct labels, SVG units. */
const LABEL_GAP = 11;

/** Small direct labels at the right end of each line, nudged apart where two would overlap, and kept above the month labels. */
function endLabels(entries: { key: string; y: number; text: string }[]): { key: string; y: number; text: string }[] {
  const sorted = [...entries].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && cur.y - prev.y < LABEL_GAP) cur.y = prev.y + LABEL_GAP;
  }
  const over = (sorted.at(-1)?.y ?? 0) - (PAD.top + PLOT_H - 4);
  if (over > 0) for (const label of sorted) label.y -= over;
  return sorted;
}

function MoneyChart({
  id,
  title,
  months,
  lines,
  hover,
  setHover,
}: {
  id: string;
  title: string;
  months: MoneyMonth[];
  lines: readonly { key: "income" | "expenses" | "treasury"; label: string }[];
  hover: number | null;
  setHover(k: number | null): void;
}) {
  const n = months.length;
  const values = lines.flatMap((l) => months.map((m) => m[l.key]));
  const chart = chartOf(values, n);
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box || n === 0) return;
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let k = 1; k < n; k++) if (Math.abs(chart.xOf(k) - x) < Math.abs(chart.xOf(best) - x)) best = k;
    setHover(best);
  };
  const labels = endLabels(lines.map((l) => ({ key: l.key, y: chart.yOf(months[n - 1]?.[l.key] ?? 0), text: lines.length > 1 ? l.label : formatMoneyShort(months[n - 1]?.[l.key] ?? 0) })));
  const at = hover !== null && hover < n ? hover : null;
  const zeroShown = (chart.ticks[0] ?? 0) < 0;
  return (
    <svg id={id} className="budget-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, ${n} months`} data-months={n}>
      {chart.ticks.map((v) => (
        <g key={v} className={v === 0 && zeroShown ? "stats-grid zero" : "stats-grid"}>
          <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={chart.yOf(v)} y2={chart.yOf(v)} />
          <text x={PAD.left - 4} y={chart.yOf(v)} dy="0.32em" textAnchor="end">{formatMoneyShort(v)}</text>
        </g>
      ))}
      {months.map((m, k) =>
        n <= 6 || k % 3 === (n - 1) % 3 ? (
          <text key={m.month} className="stats-axis" x={chart.xOf(k)} y={H - 5} textAnchor="middle">{monthLabel(m.month).split(",")[0]}</text>
        ) : null,
      )}
      {lines.map((l) => (
        <g key={l.key}>
          {n > 1 && <path className="budget-line" d={pathOf(chart, months.map((m) => m[l.key]))} stroke={COLOURS[l.key]} data-series={l.key} />}
          {n > 0 && <circle className="stats-dot" cx={chart.xOf(n - 1)} cy={chart.yOf(months[n - 1]?.[l.key] ?? 0)} r={4} fill={COLOURS[l.key]} />}
        </g>
      ))}
      {n > 0 &&
        labels.map((l) => (
          <text key={l.key} className="stats-end" x={chart.xOf(n - 1) + 7} y={l.y} dy="0.32em">{l.text}</text>
        ))}
      {at !== null && (
        <g className="stats-cross">
          <line x1={chart.xOf(at)} x2={chart.xOf(at)} y1={PAD.top} y2={PAD.top + PLOT_H} />
          {lines.map((l) => (
            <circle key={l.key} className="stats-dot" cx={chart.xOf(at)} cy={chart.yOf(months[at]?.[l.key] ?? 0)} r={4} fill={COLOURS[l.key]} />
          ))}
        </g>
      )}
      <rect className="stats-hit" x={PAD.left} y={0} width={PLOT_W} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
    </svg>
  );
}

/** A key that changes when the money history does, so the graph re-reads it. */
function historyKey(s: MirrorState): string {
  return s ? `${s.stats.next},${s.stats.money.income.length},${gameDate(Math.max(0, s.tick - 1)).month}` : "";
}

function MoneyGraph() {
  useSim(historyKey);
  const s = useSim((state) => state);
  const [hover, setHover] = useState<number | null>(null);
  if (!s) return null;
  const months = moneyMonths(s.stats, s.tick);
  const n = months.length;
  const shown = months[hover !== null && hover < n ? hover : n - 1];
  return (
    <section className="budget-section" aria-label="The last year">
      {n === 0 ? (
        <p className="hint">No month has closed yet.</p>
      ) : (
        <>
          <div className="budget-legend" aria-hidden="true">
            <span><span className="stats-key" style={{ background: COLOURS.income }} />Income</span>
            <span><span className="stats-key" style={{ background: COLOURS.expenses }} />Expenses</span>
          </div>
          <h4>Income and expenses each month</h4>
          <MoneyChart
            id="budget-flow-graph"
            title="Income and expenses each month"
            months={months}
            lines={[
              { key: "income", label: "Income" },
              { key: "expenses", label: "Expenses" },
            ]}
            hover={hover}
            setHover={setHover}
          />
          <h4>Treasury at each month's close</h4>
          <MoneyChart id="budget-treasury-graph" title="Treasury at each month's close" months={months} lines={[{ key: "treasury", label: "Treasury" }]} hover={hover} setHover={setHover} />
          {shown && (
            <p className="budget-readout" id="budget-month" role="status">
              <strong>{monthLabel(shown.month)}</strong>: income {formatMoneyShort(shown.income)}, expenses {formatMoneyShort(shown.expenses)}, net{" "}
              {shown.income - shown.expenses > 0 ? "+" : ""}
              {formatMoneyShort(shown.income - shown.expenses)}, treasury at its close {formatMoneyShort(shown.treasury)}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// --- Sliders ---------------------------------------------------------------------

/**
 * A slider that shows where it is while it is dragged and sends one command
 * when it is let go: the input's native change event, which fires on
 * release, or on each step of the arrow keys.
 */
function Slider({
  id,
  label,
  note,
  min,
  max,
  step,
  value,
  format,
  send,
}: {
  id: string;
  label: string;
  note: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format(v: number): string;
  send(v: number): Promise<CommandResult>;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const valueRef = useRef(value);
  valueRef.current = value;
  /** Commands sent and not yet settled, and whether the thumb has moved since the last one was sent. */
  const pending = useRef(0);
  const dragging = useRef(false);
  const noteId = useId();
  // The draft gives way to the sim's value once nothing is in flight or in hand, so another player's change shows too.
  useEffect(() => {
    if (pending.current === 0 && !dragging.current) setDraft(null);
  }, [value]);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const onChange = () => {
      dragging.current = false;
      const sent = Number(input.value);
      pending.current += 1;
      const settle = (ok: boolean, reason?: string) => {
        pending.current -= 1;
        setProblem(ok ? null : (reason ?? "Refused"));
        if (pending.current > 0 || dragging.current) return;
        // Refused, or applied with its delta already in: show the sim's value.
        if (!ok || Math.abs(valueRef.current - sent) < 1e-9) setDraft(null);
      };
      sendRef.current(sent).then(
        (result) => settle(result.ok, result.ok ? undefined : result.reason),
        () => settle(false, "The command was not sent"),
      );
    };
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, []);
  const shown = draft ?? value;
  return (
    <div className="budget-slider">
      <label htmlFor={id}>
        <span>{label}</span>
        <output htmlFor={id}>{format(shown)}</output>
      </label>
      <input
        ref={ref}
        type="range"
        id={id}
        min={min}
        max={max}
        step={step}
        value={shown}
        data-value={value}
        aria-describedby={noteId}
        aria-valuetext={format(shown)}
        onChange={(e) => {
          dragging.current = true;
          setDraft(Number(e.target.value));
        }}
      />
      <div className="budget-ends" aria-hidden="true">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
      <p className="hint" id={noteId}>{note}</p>
      {problem && <p className="hint bad">{problem}</p>}
    </div>
  );
}

function TaxSliders() {
  const { sendCommand } = useServices();
  const rates = useSim((s) => s?.budget.taxRates ?? null);
  if (!rates) return null;
  return (
    <section className="budget-section" aria-label="Tax rates">
      {TAX_SLIDERS.map((slider, i) => (
        <Slider
          key={slider.zone}
          id={`tax-${slider.zone}`}
          label={slider.label}
          note={slider.note}
          min={slider.min}
          max={slider.max}
          step={TAX_STEP}
          value={rates[i] ?? slider.default}
          format={formatRate}
          send={(v) => sendCommand("SetTaxRate", { zone: slider.zone, rate: taxRateOfSlider(v) })}
        />
      ))}
    </section>
  );
}

function ChargeSliders() {
  const { sendCommand } = useServices();
  const rates = useSim((s) => s?.budget.chargeRates ?? null);
  if (!rates) return null;
  return (
    <section className="budget-section" aria-label="Development charges">
      {CHARGE_SLIDERS.map((slider, i) => (
        <Slider
          key={slider.zone}
          id={`charge-${slider.zone}`}
          label={slider.label}
          note={slider.note}
          min={slider.min}
          max={slider.max}
          step={1}
          value={rates[i] ?? slider.default}
          format={formatCharge}
          send={(v) => sendCommand("SetDevelopmentCharge", { zone: slider.zone, rate: Math.round(v) })}
        />
      ))}
    </section>
  );
}

// --- Loans -----------------------------------------------------------------------

function LoanRow({ loan }: { loan: Loan }) {
  const { sendCommand, mirror } = useServices();
  const refusal = useSim((s) => (s ? mirror.spendingRefusal(loan.balance) : null));
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const repay = () => {
    setSending(true);
    sendCommand("RepayLoan", { loan: loan.id }).then(
      (r) => {
        setSending(false);
        setProblem(r.ok ? null : (r.reason ?? "Refused"));
      },
      () => {
        setSending(false);
        setProblem("The command was not sent");
      },
    );
  };
  return (
    <tr data-loan={loan.id} data-balance={loan.balance} data-repayment={loan.repayment} data-months-left={loan.monthsLeft}>
      <th scope="row">Loan {loan.id + 1}</th>
      <td><Money value={loan.balance} /></td>
      <td><Money value={loan.repayment} /></td>
      <td>{loan.monthsLeft}</td>
      <td>
        <button
          type="button"
          id={`repay-loan-${loan.id}`}
          disabled={refusal !== null || sending}
          title={refusal ?? `Pay off the ${formatMoneyFull(loan.balance)} still owed`}
          onClick={repay}
        >
          Repay
        </button>
        {problem && <span className="hint bad">{problem}</span>}
      </td>
    </tr>
  );
}

function Loans() {
  const { sendCommand, mirror } = useServices();
  const budget = useSim((s) => s?.budget ?? null);
  const limit = useSim(() => mirror.credit()?.limit ?? 0);
  const left = useSim(() => mirror.credit()?.left ?? 0);
  const offers = ECONOMY.loans.offers;
  const [amount, setAmount] = useState("");
  const [term, setTerm] = useState(offers[0]?.termMonths ?? 0);
  const [problem, setProblem] = useState<string | null>(null);
  /** A loan is on its way: the button waits, so a double click takes one loan, not two. */
  const [sending, setSending] = useState(false);
  const principal = Number(amount);
  const valid = amount.trim() !== "" && Number.isSafeInteger(principal) && principal >= 1;
  const refusal = useSim((s) => (s && valid ? mirror.loanRefusal(principal, term) : null));
  if (!budget) return null;
  const loans = loansOf(budget);
  const owed = debtOf(budget);
  const offer = offers.find((o) => o.termMonths === term);
  const repayment = valid && offer ? monthlyRepayment(principal, offer.annualRate, offer.termMonths) : null;
  const take = () => {
    if (!valid || sending) return;
    setSending(true);
    sendCommand("TakeLoan", { principal, termMonths: term }).then(
      (r) => {
        setSending(false);
        setProblem(r.ok ? null : (r.reason ?? "Refused"));
        if (r.ok) setAmount("");
      },
      () => {
        setSending(false);
        setProblem("The command was not sent");
      },
    );
  };
  const malformed = amount.trim() !== "" && !valid ? "Borrow whole dollars, at least $1" : null;
  const shownProblem = malformed ?? refusal ?? problem;
  return (
    <section className="budget-section" aria-label="Loans">
      <p id="budget-credit" data-limit={limit} data-owed={owed} data-left={left}>
        Owed <Money value={owed} /> of a credit limit of <Money value={limit} />, <Money value={left} /> left to borrow. {loans.length} of {ECONOMY.loans.maxOpen} loans open.
      </p>
      {loans.length > 0 && (
        <table className="budget-loans" id="budget-loans">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">Owed</th>
              <th scope="col">A month</th>
              <th scope="col">Months left</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {loans.map((loan) => (
              <LoanRow key={loan.id} loan={loan} />
            ))}
          </tbody>
        </table>
      )}
      <form
        className="budget-take"
        onSubmit={(e) => {
          e.preventDefault();
          take();
        }}
      >
        <label>
          Borrow $
          <input id="loan-amount" type="number" min={1} step={1} inputMode="numeric" placeholder="whole dollars" value={amount} onChange={(e) => {
              setAmount(e.target.value);
              setProblem(null);
            }}
          />
        </label>
        <label>
          over
          <select id="loan-term" value={term} onChange={(e) => {
              setTerm(Number(e.target.value));
              setProblem(null);
            }}>
            {offers.map((o) => (
              <option key={o.termMonths} value={o.termMonths}>
                {o.termMonths / 12} years at {formatRate(o.annualRate)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" id="take-loan" disabled={!valid || refusal !== null || sending}>Take loan</button>
      </form>
      {repayment !== null && refusal === null && <p className="hint">Repays {formatMoneyShort(repayment)} a month, from the month after this one.</p>}
      {shownProblem && <p className="hint bad" id="loan-refusal">{shownProblem}</p>}
    </section>
  );
}

// --- The panel -------------------------------------------------------------------

/** The panel's tabs, in order. Only the open one is drawn. */
const TABS = [
  { key: "budget", label: "Budget" },
  { key: "charts", label: "Charts" },
  { key: "loans", label: "Loans" },
  { key: "taxes", label: "Taxes" },
  { key: "charges", label: "Dev charges" },
] as const;
type BudgetTab = (typeof TABS)[number]["key"];

const tabId = (tab: BudgetTab) => `budget-tab-${tab}`;
const tabPanelId = (tab: BudgetTab) => `budget-tabpanel-${tab}`;

/** The tab row, with the arrow keys, Home and End moving between tabs as a tab list's do. */
function Tabs({ tab, setTab }: { tab: BudgetTab; setTab(tab: BudgetTab): void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.key === tab);
    const to =
      e.key === "ArrowRight" ? (at + 1) % TABS.length
      : e.key === "ArrowLeft" ? (at - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : null;
    const next = to === null ? undefined : TABS[to];
    if (!next) return;
    // The arrows would otherwise pan the camera too.
    e.preventDefault();
    e.stopPropagation();
    setTab(next.key);
    document.getElementById(tabId(next.key))?.focus();
  };
  return (
    <div className="budget-tabs" role="tablist" aria-label="Budget sections" onKeyDown={onKeyDown}>
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          id={tabId(t.key)}
          aria-selected={t.key === tab}
          aria-controls={tabPanelId(t.key)}
          tabIndex={t.key === tab ? 0 : -1}
          onClick={() => setTab(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function BudgetBody({ tab, setTab }: { tab: BudgetTab; setTab(tab: BudgetTab): void }) {
  const s = useSim((state) => state);
  // The columns' names follow the month, and the ledger the budget, which a delta replaces whole.
  useSim((state) => state?.budget);
  useSim((state) => (state ? gameDate(state.tick).month : 0));
  return (
    <>
      <div className="stats-sticky">
        <div className="stats-title">
          <h2>Budget</h2>
          <button type="button" className="stats-close" aria-label="Close the budget" onClick={toggleBudget}>×</button>
        </div>
        <Tabs tab={tab} setTab={setTab} />
      </div>
      {s ? (
        <div className="budget-tabpanel" role="tabpanel" id={tabPanelId(tab)} aria-labelledby={tabId(tab)}>
          {tab === "budget" && <Ledger s={s} />}
          {tab === "charts" && <MoneyGraph />}
          {tab === "loans" && <Loans />}
          {tab === "taxes" && <TaxSliders />}
          {tab === "charges" && <ChargeSliders />}
        </div>
      ) : null}
    </>
  );
}

/** The panel itself. Closed, it reads nothing and draws nothing, and opens again on the tab it was left on. */
export function BudgetPanel() {
  const open = useUi((u) => u.budgetOpen);
  const order = usePanelOrder("budget");
  const [tab, setTab] = useState<BudgetTab>("budget");
  return (
    <section id="budget-panel" className="panel stats-panel budget-panel" aria-label="Budget" hidden={!open} style={{ order }}>
      {open && <BudgetBody tab={tab} setTab={setTab} />}
    </section>
  );
}
