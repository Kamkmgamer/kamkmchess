'use client';

import {Button as ButtonPrimitive} from '@base-ui/react/button';
import {Toggle as TogglePrimitive} from '@base-ui/react/toggle';
import {cva, type VariantProps} from 'class-variance-authority';
import {createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type Ref} from 'react';
import {Icon, ArrowRight, CircleDash} from '../icon';
import type {Kind} from '../../../lib/quartz/kind';
import {cn, controlHeight, mergeClass, mergeRefs} from '../../../lib/quartz/utils';

// Quartz's button (cva variants, data-slot, Base UI primitive underneath).
// 32px tall (28 at sm, 44 at lg), the 6px control corner, a 14/16 label (16 at lg). Primary is the one ink fill in a view,
// the button a person presses. Secondary is paper with the 1px control edge and a short lift; hover darkens the edge and
// washes the fill. Destructive is written, not painted: paper, a fail edge and fail text, never a red fill. Focus is the
// 2px keyboard ring, on every variant.
//
// Two modes on one component:
// - pending: waiting on the action it started. The idle label and the pending label share one grid cell,
//   so the box never changes size, and the idle label stays in the accessibility tree, so the name never
//   changes either ("Issue refund, busy", not "Refunding").
// - pressed (was Toggle): a button that stays on. Rendered on Base UI Toggle, so it gets aria-pressed.
//   Pressed is an ink fill, the person's hand on it; `kind` only sets data-kind for what is inside.
//
// Variant link takes Link standalone's type role (14/16), gap and 24px floor, so an action and a
// navigation set as links read as one size.
//
// Height is max(--control, one line plus the padding), so a label at 200% text zoom grows the box
// instead of spilling out of it, while the box keeps an explicit height that flex rows cannot stretch.

const buttonVariants = cva(
  [
    'group/button relative inline-flex max-w-full shrink-0 items-center justify-center gap-2 rounded-soft whitespace-nowrap select-none',
    'type-label transition-[background-color,color,scale,outline-color,box-shadow] duration-(--dur-fast) ease-(--ease-step) [-webkit-tap-highlight-color:transparent]',
    'active:not-data-disabled:scale-98 active:duration-(--dur-press) motion-reduce:scale-none!',
    'data-disabled:not-aria-busy:text-text-disabled data-disabled:not-aria-busy:cursor-not-allowed aria-busy:cursor-progress',
    // Pressed (toggle mode): ink fill, whatever the kind. Hue never fills a button.
    'data-pressed:not-data-disabled:bg-inverse data-pressed:not-data-disabled:text-text-inverse data-pressed:not-data-disabled:shadow-none data-pressed:hover:not-data-disabled:bg-button-primary-hover',
    'data-disabled:data-pressed:bg-pressed',
    // Forced colors drop every fill, so the box comes back as a system-colored border, disabled maps to
    // GrayText, and pressed keeps a Highlight fill the person can see.
    'forced-colors:border forced-colors:border-solid forced-colors:border-[ButtonText]',
    'forced-colors:data-disabled:not-aria-busy:border-[GrayText] forced-colors:data-disabled:not-aria-busy:text-[GrayText]',
    'forced-colors:data-pressed:[forced-color-adjust:none] forced-colors:data-pressed:bg-[Highlight]! forced-colors:data-pressed:text-[HighlightText]!',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        // primary, secondary and destructive are keys (styles.css key-*): a lit body, a lip and a base, a hover light and a
        // sheen. Disabled primary fades with --dim-opacity; secondary and destructive keep the shape with a faint edge.
        primary: 'key key-primary text-text-inverse data-disabled:not-aria-busy:opacity-(--dim-opacity) data-disabled:not-aria-busy:text-text-inverse data-disabled:not-aria-busy:shadow-none',
        secondary: 'key key-secondary text-text-1 hover:not-data-disabled:not-data-pressed:[--frame-color:var(--line-control-hover)] data-disabled:not-aria-busy:[--frame-color:var(--text-disabled)]',
        ghost: 'touch-target bg-ghost text-text-1 hover:not-data-disabled:not-data-pressed:bg-ghost-hover active:not-data-disabled:not-data-pressed:bg-pressed',
        destructive: 'key key-secondary text-fail-text [--frame-color:var(--fail-line)] hover:not-data-disabled:[--frame-color:var(--fail-text)] data-disabled:not-aria-busy:text-text-disabled data-disabled:not-aria-busy:[--frame-color:var(--text-disabled)]',
        link: 'h-auto! min-h-6 px-0! gap-1 type-label bg-transparent text-foreground underline-offset-4 decoration-1 hover:not-data-disabled:underline forced-colors:border-0 forced-colors:underline',
      },
      size: {
        xs: `${controlHeight.xs} px-2 gap-1 type-label-sm [&_svg]:size-3.5`,
        sm: `${controlHeight.sm} px-3 gap-1.5 type-label`,
        default: `${controlHeight.default} px-4`,
        lg: `${controlHeight.lg} px-5 type-button`,
        icon: 'size-(--control) px-0',
        'icon-xs': 'size-(--control-xs) px-0',
        'icon-sm': 'size-(--control-sm) px-0',
        'icon-lg': 'size-(--control-lg) px-0',
      },
    },
    defaultVariants: {variant: 'primary', size: 'default'},
  },
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & {
  /**
   * Waiting on the action this button started. The button becomes disabled against repeat presses but
   * keeps focus, sets aria-busy and shows a spinner. Pass the prop (true or false) on any button that
   * can be pending: it reserves the spinner's room from the start, so the box never changes size.
   */
  pending?: boolean;
  /**
   * An optional pending verb ("Refunding"). Both labels share one grid cell, so the box fits the longer.
   * It is shown, not announced: the accessible name stays the idle label and aria-busy says it is working.
   */
  pendingLabel?: ReactNode;
  /** An arrow 8px after the label, pointing along the reading direction. Off by default, link buttons included: no arrow links. */
  arrow?: boolean;
  /**
   * Pressed mode (was Toggle): the button stays on until pressed again. Controlled with `pressed` and
   * `onPressedChange`, or uncontrolled with `defaultPressed`. Renders Base UI Toggle with aria-pressed.
   * Defaults the variant to ghost. `pending` does not apply in this mode.
   */
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean, details: TogglePrimitive.ChangeEventDetails) => void;
  /** Pressed mode only: sets data-kind for what is inside (a Badge takes the kind); the fill stays ink. */
  kind?: Kind;
  ref?: Ref<HTMLButtonElement>;
};

function Spinner() {
  return <Icon icon={CircleDash} size={16} data-slot="button-spinner" className="animate-spin motion-reduce:animate-none"/>;
}

/** The text a screen reader would name the button by, roughly: text outside aria-hidden parts. */
function visibleName(el: HTMLElement): string {
  const label = el.getAttribute('aria-label') ?? '';
  if (label.trim() || el.getAttribute('aria-labelledby')) return label || 'labelledby';
  let text = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent ?? ''; return; }
    if (node instanceof Element && (node.getAttribute('aria-hidden') === 'true')) return;
    if (node instanceof Element && node.getAttribute('role') === 'img') { text += node.getAttribute('aria-label') ?? ''; return; }
    node.childNodes.forEach(walk);
  };
  walk(el);
  return text.trim();
}

/**
 * Development only: a button with no accessible name (empty children, whitespace, or an icon size with
 * no aria-label) is announced as just "button". Report it once per element, with the element, so the
 * call site can be found from the console.
 */
function useNameCheck(component = 'Button', hint = 'Give it text children, or aria-label on an icon size.') {
  const node = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV || !node.current) return;
    if (!visibleName(node.current)) {
      node.current.setAttribute('data-unnamed', '');
      console.error(`Quartz ${component} has no accessible name. ${hint}`, node.current);
    } else node.current.removeAttribute('data-unnamed');
  });
  return node;
}

/**
 * The size a Button takes when its caller names none. A compact container sets it so its actions sit 8px from its
 * edges without each call site passing size: a 40px header sets xs (24px), a 44px footer sets sm (28px). An explicit
 * size wins.
 */
const ButtonSizeContext = createContext<'xs' | 'sm' | 'default' | undefined>(undefined);
function ButtonSize({size, children}: {size: 'xs' | 'sm' | 'default'; children?: ReactNode}) {
  return <ButtonSizeContext.Provider value={size}>{children}</ButtonSizeContext.Provider>;
}

function Button({
  className, variant, size: sizeProp,  pending, pendingLabel, arrow, disabled, focusableWhenDisabled,
  pressed, defaultPressed, onPressedChange, kind, children, ref, ...props
}: ButtonProps) {
  const scoped = useContext(ButtonSizeContext);
  const size = sizeProp ?? scoped ?? 'default';
  const toggle = pressed !== undefined || defaultPressed !== undefined || onPressedChange !== undefined;
  const v = variant ?? (toggle ? 'ghost' : 'primary');
  const canPend = !toggle && pending !== undefined;
  const showArrow = !size?.startsWith('icon') && !!arrow;
  const named = useNameCheck();
  const mergedRef = useMemo(() => mergeRefs(ref as Ref<HTMLElement> | undefined, named), [ref, named]);

  // Both labels live in one grid cell. The idle label only fades (opacity), so it keeps the name; the
  // pending layer is aria-hidden, so the pending verb is shown but never renames the control.
  // A text label never wraps. The button is never wider than its container, so a label too long for it ends
  // in an ellipsis; the full label stays the accessible name.
  const label = typeof children === 'string' ? <span data-slot="button-text" className="min-w-0 truncate">{children}</span> : children;
  const gap = size === 'sm' ? 'gap-1.5' : 'gap-2';
  const content = canPend
    ? <span data-slot="button-stack" className="grid min-w-0 place-items-center [grid-template-areas:'stack']">
        <span data-slot="button-idle" className={cn('inline-flex max-w-full min-w-0 items-center [grid-area:stack]', gap, pending && 'opacity-0')}>{label}</span>
        <span data-slot="button-pending" aria-hidden className={cn('inline-flex max-w-full min-w-0 items-center [grid-area:stack]', gap, !pending && 'invisible')}>
          <Spinner/>{size?.startsWith('icon') ? null : typeof pendingLabel === 'string' ? <span className="min-w-0 truncate">{pendingLabel}</span> : pendingLabel ?? label}
        </span>
      </span>
    : label;
  const tail = showArrow && <Icon icon={ArrowRight} size={16} data-slot="button-arrow" data-icon="inline-end" className="rtl:-scale-x-100"/>;
  const classes = mergeClass(buttonVariants({variant: v, size}), className);

  // Base UI Toggle has no focusableWhenDisabled, so a disabled toggle that must stay in the tab order
  // stays enabled for the browser, says aria-disabled, carries data-disabled for the styles, and cancels
  // every press.
  if (toggle) {
    const softDisabled = !!disabled && !!focusableWhenDisabled;
    // Base UI Toggle sets no data-disabled of its own, so the native-disabled case gets it here too.
    return <TogglePrimitive
      data-slot="button"
      data-variant={v}
      data-kind={kind}
      ref={mergedRef as Ref<HTMLButtonElement>}
      pressed={pressed}
      defaultPressed={defaultPressed}
      onPressedChange={softDisabled ? (_next, details) => details.cancel() : onPressedChange}
      disabled={softDisabled ? false : disabled}
      aria-disabled={softDisabled || undefined}
      data-disabled={disabled ? '' : undefined}
      className={classes as TogglePrimitive.Props['className']}
      {...(props as TogglePrimitive.Props)}
    >{label}{tail}</TogglePrimitive>;
  }

  return <ButtonPrimitive
    data-slot="button"
    data-variant={v}
    ref={mergedRef}
    disabled={disabled || pending}
    focusableWhenDisabled={pending || focusableWhenDisabled}
    aria-busy={pending || undefined}
    className={classes}
    {...props}
  >
    {content}
    {tail}
  </ButtonPrimitive>;
}

export {Button, ButtonSize, buttonVariants, useNameCheck, type ButtonProps};
