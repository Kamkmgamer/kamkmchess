'use client';

import {Radio as RadioPrimitive} from '@base-ui/react/radio';
import {RadioGroup as RadioGroupPrimitive} from '@base-ui/react/radio-group';
import {useId, type ReactNode} from 'react';
import {cn, mergeClass} from '../../../lib/quartz/utils';

// Quartz's radio group, on Base UI's RadioGroup and Radio. One tab stop for the group;
// arrow keys move the choice. Each radio is a 16px circle (the one round control besides avatars, so it
// never reads as a checkbox; the documented --radius-full exception) with a 1px control edge at --border-control (control-edge), ink on hover; the
// chosen one is solid ink with a paper dot. Invalid (aria-invalid on the group) sets data-status="fail"
// and every circle's edge turns to the fail line.
//
// Radios exist to compare a few choices, so RadioGroupOption carries each choice's consequence: a label
// and a description line, both inside one label so the whole row is the target, with the description
// tied by aria-describedby. Arrowing through the group, a screen reader hears "Pro, 10,000 conversations a month,
// radio button, 2 of 3", not three bare names.
//
// Forced colors drop the edge colour and the fills, so each circle draws a system border and the chosen one
// keeps a Highlight fill with a HighlightText dot.

type RadioGroupProps = RadioGroupPrimitive.Props & {'aria-invalid'?: boolean | 'true' | 'false'};

function RadioGroup({className, 'aria-invalid': invalid, ...props}: RadioGroupProps) {
  const isInvalid = invalid === true || invalid === 'true';
  return <RadioGroupPrimitive
    data-slot="radio-group"
    data-status={isInvalid ? 'fail' : undefined}
    aria-invalid={isInvalid || undefined}
    className={mergeClass('group/radio-group grid w-full gap-3', className)}
    {...props}
  />;
}

function RadioGroupItem({className, ...props}: RadioPrimitive.Root.Props) {
  return <RadioPrimitive.Root
    data-slot="radio-group-item"
    className={mergeClass([
      'peer relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full [-webkit-tap-highlight-color:transparent]',
      'bg-page control-edge [--frame-color:var(--border-control)] transition-[background-color,box-shadow,outline-color] duration-(--dur-fast) ease-(--ease-step)',
      'not-pointer-coarse:after:absolute not-pointer-coarse:after:-inset-1.5 touch-target',
      'hover:not-data-disabled:not-data-readonly:not-data-checked:group-not-aria-invalid/radio-group:[--frame-color:var(--ink)]',
      'data-checked:bg-ink',
      'active:not-data-disabled:not-data-readonly:not-data-checked:bg-pressed active:not-data-disabled:not-data-readonly:data-checked:bg-button-primary-hover active:not-data-disabled:not-data-readonly:duration-(--dur-press)',
      'group-aria-invalid/radio-group:[--frame-color:var(--fail-line)]',
      'data-disabled:cursor-not-allowed data-disabled:bg-page data-disabled:[--frame-color:var(--text-disabled)] data-disabled:[--control-lift:var(--elev-none)] data-disabled:data-checked:bg-text-disabled',
      'data-readonly:cursor-default',
      'forced-colors:border forced-colors:border-solid forced-colors:border-[CanvasText] forced-colors:data-disabled:border-[GrayText]',
      'forced-colors:data-checked:[forced-color-adjust:none] forced-colors:data-checked:bg-[Highlight]!',
    ], className)}
    {...props}
  >
    <RadioPrimitive.Indicator data-slot="radio-group-indicator" className="size-1.5 rounded-full bg-paper forced-colors:[forced-color-adjust:none] forced-colors:bg-[HighlightText]"/>
  </RadioPrimitive.Root>;
}

type RadioGroupOptionProps = Omit<RadioPrimitive.Root.Props, 'children' | 'className'> & {
  /** Classes for the row, a plain label around the radio. */
  className?: string;
  /** The choice's name, one to three words. */
  label: ReactNode;
  /** What picking it means: a limit, a price, a consequence. Read with the name. */
  description?: ReactNode;
};

/** A radio with its label and an optional description in one target row. */
function RadioGroupOption({label, description, className, ...props}: RadioGroupOptionProps) {
  const id = useId();
  return <label data-slot="radio-group-option" className={cn('flex cursor-pointer items-start gap-3 has-data-disabled:cursor-not-allowed', className)}>
    <RadioGroupItem aria-labelledby={`${id}-l`} aria-describedby={description ? `${id}-d` : undefined} {...props}/>
    <span className="flex min-w-0 flex-col gap-0.5 peer-data-disabled:*:text-text-disabled">
      <span id={`${id}-l`} className="type-label text-text-1">{label}</span>
      {description && <span id={`${id}-d`} className="type-body-sm text-text-2">{description}</span>}
    </span>
  </label>;
}

export {RadioGroup, RadioGroupItem, RadioGroupOption, type RadioGroupProps, type RadioGroupOptionProps};
