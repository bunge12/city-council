// A button a population milestone opens (M4-12). Until the city reaches
// it, the button is greyed, does nothing when clicked, and says on hover
// which milestone opens it: "Medium density is locked until the Village
// milestone, at 1,000 residents". The density picks use it now; each later
// thing a milestone opens, City Hall first, uses it the same way.
//
// It stays focusable and keeps its pointer events (`aria-disabled`, not
// `disabled`), so the browser still shows its tooltip on hover.

import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Unlock } from "@city-council/sim";
import { useLockNote } from "./hooks";

interface UnlockButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** The unlock the button waits for, or undefined for one that is never locked. */
  unlock: Unlock | undefined;
  /** The tooltip once it is open. */
  title: string;
  children: ReactNode;
}

export function UnlockButton({ unlock, title, onClick, children, ...rest }: UnlockButtonProps) {
  const lock = useLockNote(unlock);
  return (
    <button
      type="button"
      {...rest}
      aria-disabled={lock === null ? undefined : true}
      data-locked={lock === null ? undefined : "true"}
      title={lock ?? title}
      onClick={lock === null ? onClick : undefined}
    >
      {children}
    </button>
  );
}
