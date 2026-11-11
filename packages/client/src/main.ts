import { simInfo } from "@city-council/sim";

const info = simInfo();
const el = document.getElementById("sim-info");
if (el) {
  el.textContent = `${info.name}, tick ${info.tickMs} ms`;
}
