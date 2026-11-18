# M3-02: Sound: audio engine, settings and interface sounds

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: M2.

## Goal

The tools make sounds. See "Sound" in the PRD.

## Scope

- An audio engine in the client on Web Audio. It starts on the player's first click or key, because browsers block audio before that
- A cap on how many sounds play at once. The cap is a number in the client's config
- Interface cues, synthesised in code: a road placed, a zone painted, a bulldoze, an undo, and an action the sim rejects
- A cue plays when the sim's answer arrives, not on the click, so a rejected command never sounds like a success
- A sound settings control in the top bar: volume for interface, volume for ambience, and a mute. The choice is kept in this browser, like the graphics preset
- A test hook that reports which cues the engine was asked to play, so Playwright can check them without listening

## Out of scope

- Ambient layers. Wind and construction are issue 19, and the rest arrive with their modules
- The cues for money spent and a milestone reached, which wait for M4
- Music and its volume control, which are M11
- Recordings. Every sound here is generated in code
- Anything in `packages/sim`. Sound never touches the sim

## Done when

- [ ] Unit tests for the engine: the voice cap holds, mute silences everything, and no sound is scheduled before the first interaction
- [ ] A Playwright test places a road, paints a zone, bulldozes and sends a command the sim rejects, and reads the four cues from the test hook in order
- [ ] The same test sets the interface volume to zero, reloads, and finds the setting kept
- [ ] No audio file in the repo, and no change to sim state, the snapshot version or the protocol version
- [ ] Browser evidence on the pull request: a short screen recording with sound, or the settings control and the hook's output if a recording cannot carry audio

## Notes

This goes first on the client side because the PRD puts it at the start of M3, and it depends on nothing else here.

The engine is built for the ambient layers that follow: a layer has a volume that the view sets, and issue 19 adds the first two. Keep that seam, but build no layer here.

Cues should be short and quiet by default. A zone stroke that paints 200 cells is one cue, not 200.
