import { useId, useState, type FocusEventHandler, type PointerEventHandler, type ReactNode } from "react";

/** Whether a tip shows, and the handlers that open and close it (`useTipState`). */
export interface TipState {
  id: string;
  shown: boolean;
  onPointerEnter: PointerEventHandler;
  onPointerLeave: PointerEventHandler;
  onFocus: FocusEventHandler;
  onBlur: FocusEventHandler;
}

/** What an element with a tip spreads, and the tip it renders inside itself. */
export interface TipParts {
  props: {
    "data-tip": string;
    "aria-describedby": string | undefined;
    tabIndex: number;
    onPointerEnter: PointerEventHandler;
    onPointerLeave: PointerEventHandler;
    onFocus: FocusEventHandler;
    onBlur: FocusEventHandler;
  };
  tip: ReactNode;
}

/**
 * Whether a tip shows: while the pointer is over its element, or the
 * element has focus. For a tip whose text costs something to work out, so
 * it is worked out only while the tip shows (the residential bar's homes
 * waiting, #330); render it with `tipParts`. Most tips use `useTip`.
 */
export function useTipState(): TipState {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return {
    id,
    shown: hovered || focused,
    // A touch shows the tip by focus instead, so it does not flash on and off.
    onPointerEnter: (e) => setHovered(e.pointerType !== "touch"),
    onPointerLeave: () => setHovered(false),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}

/** The props and tip for `text`, shown as `state` says. */
export function tipParts(state: TipState, text: string): TipParts {
  const { id, shown, onPointerEnter, onPointerLeave, onFocus, onBlur } = state;
  return {
    props: { "data-tip": text, "aria-describedby": shown ? id : undefined, tabIndex: 0, onPointerEnter, onPointerLeave, onFocus, onBlur },
    tip: shown ? (
      <span className="tip" id={id} role="tooltip">
        {text}
      </span>
    ) : null,
  };
}

/**
 * A tooltip that shows the moment the pointer is over its element, or the
 * element has focus, where a `title` waits a second or more (issue #332).
 * The element spreads `props` and renders `tip` inside itself, so the tip
 * sits next to it and reads the text live while it shows.
 */
export function useTip(text: string): TipParts {
  return tipParts(useTipState(), text);
}
