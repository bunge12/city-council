import { describe, expect, it } from "vitest";
import {
  createState,
  hashState,
  replay,
  step,
  submit,
  type Command,
  type SimState,
} from "../src/index";
import fixtureJson from "./fixtures/replay/noop-setspeed.json";
import { expectReplay, runFixture, type ReplayFixture } from "./replay-helper";

const fixture = fixtureJson as ReplayFixture;

function cmd(playerId: string, seq: number, type: string, payload: unknown = {}): Command {
  return { seq, playerId, type, payload };
}

/**
 * Plays the fixture's commands live, the way a host would: submit between
 * steps, keep stepping while paused. `pausedSteps` extra steps run at tick 5
 * while the city is paused.
 */
function playLive(pausedSteps: number): SimState {
  const state = createState(fixture.seed);
  const send = (c: Command) => expect(submit(state, c)).toEqual({ ok: true });
  while (state.tick < fixture.untilTick) {
    switch (state.tick) {
      case 0:
        send(cmd("p1", 1, "NoOp"));
        break;
      case 3:
        send(cmd("p1", 2, "SetSpeed", { speed: 2 }));
        break;
      case 5:
        send(cmd("p2", 1, "SetSpeed", { speed: 0 }));
        step(state);
        send(cmd("p2", 2, "NoOp", { note: "while paused" }));
        for (let i = 0; i < pausedSteps; i++) step(state);
        expect(state.tick).toBe(5);
        send(cmd("p1", 3, "SetSpeed", { speed: 4 }));
        break;
      case 12:
        send(cmd("p1", 4, "NoOp"));
        send(cmd("p2", 3, "SetSpeed", { speed: 1 }));
        break;
    }
    step(state);
  }
  return state;
}

describe("replay fixture noop-setspeed", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(state.log).toEqual(fixture.log);
    expect(state.speed).toBe(1);
  });

  it("gives the same hash when replayed twice", () => {
    expect(runFixture(fixture).hash).toBe(runFixture(fixture).hash);
  });

  it.each([1, 5])("matches the same commands stepped live, with %d paused steps", (pausedSteps) => {
    const live = playLive(pausedSteps);
    expect(live.log).toEqual(fixture.log);
    expect(hashState(live)).toBe(fixture.hash);
  });
});

describe("replay", () => {
  it("replays a live log at every tick along the way", () => {
    const live = createState(7);
    for (let t = 0; t < 50; t++) {
      if (t % 7 === 0) submit(live, cmd("p1", t, "NoOp", { t }));
      if (t % 11 === 0) submit(live, cmd("p2", t, "SetSpeed", { speed: t % 2 === 0 ? 2 : 4 }));
      step(live);
      expect(hashState(replay(7, live.log, live.tick))).toBe(hashState(live));
    }
  });

  it("leaves entries at untilTick unapplied, as live state is before that tick's step", () => {
    const state = replay(fixture.seed, fixture.log, 12);
    expect(state.tick).toBe(12);
    expect(state.speed).toBe(4);
    expect(state.log).toEqual(fixture.log.filter((e) => e.tick < 12));
  });

  it("applies entries at untilTick when they leave the city paused there, as a paused save has them", () => {
    const live = createState(5);
    while (live.tick < 30) {
      if (live.tick === 10) submit(live, cmd("p1", 1, "NoOp"));
      step(live);
    }
    submit(live, cmd("p1", 2, "SetSpeed", { speed: 0 }));
    step(live);
    submit(live, cmd("p1", 3, "NoOp", { note: "while paused" }));
    for (let i = 0; i < 4; i++) step(live);
    expect(live).toMatchObject({ tick: 30, speed: 0 });
    expect(live.log.map((e) => e.tick)).toEqual([10, 30, 30]);

    const replayed = replay(5, live.log, 30);
    expect(replayed).toMatchObject({ tick: 30, speed: 0 });
    expect(hashState(replayed)).toBe(hashState(live));
  });

  it("depends on the seed", () => {
    expect(hashState(replay(1, fixture.log, 20))).not.toBe(hashState(replay(2, fixture.log, 20)));
  });

  it("stops at the tick where the city is paused and the log ends", () => {
    const log = [{ tick: 2, seq: 1, playerId: "p1", type: "SetSpeed", payload: { speed: 0 } }];
    const state = replay(1, log, 100);
    expect(state).toMatchObject({ tick: 2, speed: 0 });
  });

  it("rejects a log that continues past a pause nothing lifts", () => {
    const log = [
      { tick: 2, seq: 1, playerId: "p1", type: "SetSpeed", payload: { speed: 0 } },
      { tick: 9, seq: 2, playerId: "p1", type: "NoOp", payload: {} },
    ];
    expect(() => replay(1, log, 100)).toThrow(/paused at tick 2/);
  });

  it("rejects a log out of tick order", () => {
    const log = [
      { tick: 3, seq: 1, playerId: "p1", type: "NoOp", payload: {} },
      { tick: 1, seq: 2, playerId: "p1", type: "NoOp", payload: {} },
    ];
    expect(() => replay(1, log, 10)).toThrow(RangeError);
  });

  it("rejects a bad untilTick", () => {
    expect(() => replay(1, [], -1)).toThrow(RangeError);
    expect(() => replay(1, [], 1.5)).toThrow(RangeError);
  });

  it("does not record an entry that fails validation, so the hash shows it", () => {
    const bad = [{ tick: 0, seq: 1, playerId: "p1", type: "SetSpeed", payload: { speed: 3 } }];
    const state = replay(1, bad, 5);
    expect(state.log).toEqual([]);
  });
});
