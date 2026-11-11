# M0-09: City file download and import

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 08.

## Goal

A player can take their city out of the browser as a file and bring it back anywhere. This is the free tier's safety net.

## Scope

- A download action that writes the current snapshot to a `.city` file named after the city
- An import action that reads a `.city` file, validates it, and adds it to the local list as a new city without overwriting an existing one
- A gentle reminder to download a copy when a city has not been exported for a while, with the interval in config

## Out of scope

- Sharing files between players as a multiplayer substitute
- Any server

## Done when

- [ ] Playwright test: download, clear site data, import, and the state hash matches the original
- [ ] Importing a file that is not a city, or is truncated, shows an error and changes nothing
- [ ] Importing the same file twice gives two separate cities
