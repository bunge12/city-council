import { useId, useState, type FocusEventHandler, type PointerEventHandler, type ReactNode } from "react";

/**
 * A tooltip that shows the moment the pointer is over its element, or the
 * element has focus, where a `title` waits a second or more (issue #332).
 * The element spreads `props` and renders `tip` inside itself, so the tip
 * sits next to it and reads the text live while it shows.
 */
export function useTip(text: string): {
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
} {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const shown = hovered || focused;
  return {
    props: {
      "data-tip": text,
      "aria-describedby": shown ? id : undefined,
      tabIndex: 0,
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
    tip: shown ? (
      <span className="tip" id={id} role="tooltip">
        {text}
      </span>
    ) : null,
  };
}
