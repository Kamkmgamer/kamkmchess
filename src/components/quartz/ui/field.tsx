'use client';

import {createContext, useContext, useEffect, useState, type ComponentProps, type ReactNode} from 'react';
import {Field as FieldPrimitive} from '@base-ui/react/field';
import {Fieldset as FieldsetPrimitive} from '@base-ui/react/fieldset';
import {Form as FormPrimitive} from '@base-ui/react/form';
import {cva, type VariantProps} from 'class-variance-authority';
import {cn, mergeClass} from '../../../lib/quartz/utils';

// Quartz's field: Field, FieldLabel, FieldDescription, FieldError, FieldSet and the
// rest), on Base UI's Field, Fieldset and Form. It also owns Label (was its own component) and Form
// (was its own component), so a label is always bound and a form always validates through its fields.
//
// Base UI wires the label's htmlFor, the description and error ids and the invalid state to any Base UI
// control inside (Input, Textarea, Combobox, Date picker), so a control never needs an id of its own.
//
// The considered detail: errors wait for the person. A field validates when focus leaves it, never on the
// first keystroke. Once it is invalid it re-checks on every change, so the error clears the moment the
// value is fixed. Then it goes back to waiting for blur. Reward early, punish late.
//
// Hue only enters through the fail status slot: an invalid field's edge turns the fail line, and the
// error text takes the fail text step. No wash: trouble is marked on the edge, not painted across it.

// ---------- the shared field box ----------

/**
 * A bare control that is its own box: Textarea, Native select, the date trigger. Paper with a 1px control edge
 * (control-edge, 3.3:1) and the 6px soft corner. The edge darkens on hover, turns ink on focus and the fail line when invalid,
 * with no outline around it. Read-only, it is a well: grey, no edge, a value to copy.
 */
const fieldControlVariants = cva(
  [
    'w-full min-w-0 rounded-soft bg-page control-edge text-text-1 type-label pointer-coarse:text-base forced-colors:border',
    'transition-[background-color,box-shadow,outline-color] duration-(--dur-fast) ease-(--ease-step)',
    'placeholder:text-text-3',
    // Focus is the edge turning ink, eased in: no outline floating off the control.
    'focus-visible:outline-none focus-visible:[--frame-color:var(--border-focus)]! focus-visible:[--control-lift:var(--focus-halo)]!',
    'aria-invalid:[--frame-color:var(--fail-line)] data-invalid:[--frame-color:var(--fail-line)]',
    'hover:not-disabled:not-data-disabled:not-aria-invalid:not-data-invalid:not-[[readonly]]:[--frame-color:var(--line-control-hover)]',
    // Disabled keeps the shape on the quiet row line and drops the lift (a zero-size shadow, so the shadow list stays valid), so it never reads heavier than the field at rest.
    'disabled:cursor-not-allowed disabled:text-text-disabled disabled:placeholder:text-text-disabled disabled:[--frame-color:var(--line-row)] disabled:[--control-lift:var(--elev-none)]',
    'data-disabled:cursor-not-allowed data-disabled:text-text-disabled data-disabled:[--frame-color:var(--line-row)] data-disabled:[--control-lift:var(--elev-none)]',
    // Read-only is a well with no edge; focus still draws the ink edge and halo over it (the rule above wins with !).
    '[&[readonly]]:bg-well [&[readonly]]:[--frame-color:transparent] [&[readonly]]:[--control-lift:var(--elev-none)]',
  ],
  {
    variants: {
      size: {
        sm: 'h-(--control-sm) px-2',
        default: 'h-(--control) px-3',
        lg: 'h-(--control-lg) px-4',
      },
    },
    defaultVariants: {size: 'default'},
  },
);

type ControlSize = NonNullable<VariantProps<typeof fieldControlVariants>['size']>;

/**
 * A box that holds a bare control plus slots: Input's prefix and suffix, Combobox's chips, the time field.
 * The control inside carries `data-control`; the box draws the paper, the 1px control edge, its darker hover and
 * ink focus and the fail edge for it, so an icon or a unit inside the box is part of the field
 * and never sits outside the edge (trap/field-affix-focus). Read-only, the box is a well with no edge.
 */
const fieldBoxVariants = cva(
  [
    'group/field-box relative flex w-full min-w-0 items-center rounded-soft bg-page control-edge text-text-1 type-label pointer-coarse:text-base forced-colors:border',
    'transition-[background-color,box-shadow,outline-color] duration-(--dur-fast) ease-(--ease-step)',
    // Focus: the edge turns ink and a soft ink halo grows around it, eased. No outline floats off the box.
    'has-[[data-control]:focus]:[--frame-color:var(--border-focus)]! has-[[data-control]:focus]:[--control-lift:var(--focus-halo)]!',
    'data-[status=fail]:[--frame-color:var(--fail-line)]',
    'has-[[data-control][aria-invalid=true]]:[--frame-color:var(--fail-line)] has-[[data-control][data-invalid]]:[--frame-color:var(--fail-line)]',
    'hover:not-data-disabled:not-has-[[data-control]:disabled]:not-data-readonly:not-data-[status=fail]:not-has-[[data-control][aria-invalid=true]]:not-has-[[data-control][data-invalid]]:[--frame-color:var(--line-control-hover)]',
    'data-disabled:cursor-not-allowed data-disabled:text-text-disabled data-disabled:[--frame-color:var(--line-row)] data-disabled:[--control-lift:var(--elev-none)]',
    'has-[[data-control]:disabled]:cursor-not-allowed has-[[data-control]:disabled]:text-text-disabled has-[[data-control]:disabled]:[--frame-color:var(--line-row)] has-[[data-control]:disabled]:[--control-lift:var(--elev-none)]',
    // Read-only is a well with no edge; focus still draws the ink edge and halo over it.
    'data-readonly:bg-well data-readonly:[--frame-color:transparent] data-readonly:[--control-lift:var(--elev-none)]',
  ],
  {
    variants: {
      size: {
        sm: 'h-(--control-sm)',
        default: 'h-(--control)',
        lg: 'h-(--control-lg)',
      },
    },
    defaultVariants: {size: 'default'},
  },
);

// ---------- Label (was its own component) ----------

const labelClasses = [
  'inline-flex w-fit max-w-full min-w-0 items-center gap-2 type-label text-text-1 select-none [overflow-wrap:anywhere]',
  '[&_svg]:shrink-0 [&_svg]:text-text-2',
  'group-data-disabled/field:text-text-disabled group-data-disabled/field:cursor-not-allowed',
  'peer-disabled:text-text-disabled peer-disabled:cursor-not-allowed',
].join(' ');

type LabelProps = ComponentProps<'label'> & {
  /** Adds a quiet "Optional" after the label. Mark the few optional fields, not the many required ones. */
  optional?: boolean;
};

/**
 * A plain label for a control that is not inside a Field. Inside a Field use FieldLabel, which Base UI
 * binds for you. Pass htmlFor, or wrap the control, or the label binds to nothing (trap/label-unbound).
 */
function Label({className, optional, children, ...props}: LabelProps) {
  return <label data-slot="label" className={cn(labelClasses, className)} {...props}>
    {children}
    {optional && <LabelHint>Optional</LabelHint>}
  </label>;
}

/** Quiet text after a label: "Optional", a unit, a limit. */
function LabelHint({className, ...props}: ComponentProps<'span'>) {
  return <span data-slot="label-hint" className={cn('type-body-sm text-text-3', className)} {...props}/>;
}

// ---------- Field ----------

// Base UI's description and error throw outside a Field.Root. A FieldSet uses a description under its
// legend, so these parts check this flag and fall back to plain elements outside a Field.
const InField = createContext(false);

// Whether the Field (or a FieldSet around it) is disabled. A control reads it so its own buttons and
// hidden inputs go quiet with the text, which the :disabled state of Base UI's input alone does not reach.
const FieldDisabled = createContext(false);

/** True inside a disabled Field or FieldSet. Combine it with the control's own disabled prop. */
function useFieldDisabled() {
  return useContext(FieldDisabled);
}

/** Groups fieldsets and fields with a 24px rhythm, and is the container responsive fields query. */
function FieldGroup({className, ...props}: ComponentProps<'div'>) {
  return <div
    data-slot="field-group"
    className={cn('group/field-group @container/field-group flex w-full flex-col gap-6 *:data-[slot=field-group]:gap-4', className)}
    {...props}
  />;
}

/** A titled set of related fields: a fieldset with a legend. Disabling it disables every field inside. */
function FieldSet({className, ...props}: FieldsetPrimitive.Root.Props) {
  return <FieldsetPrimitive.Root
    data-slot="field-set"
    className={mergeClass('flex min-w-0 flex-col gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3', className)}
    {...props}
  />;
}

function FieldLegend({className, variant = 'legend', ...props}: FieldsetPrimitive.Legend.Props & {variant?: 'legend' | 'label'}) {
  return <FieldsetPrimitive.Legend
    data-slot="field-legend"
    data-variant={variant}
    className={mergeClass([
      'text-text-1 data-[variant=label]:type-label data-[variant=legend]:type-heading-sm',
      'data-disabled:text-text-disabled',
    ], className)}
    {...props}
  />;
}

const fieldVariants = cva('group/field flex w-full min-w-0 gap-2', {
  variants: {
    orientation: {
      vertical: 'flex-col *:w-full [&>.sr-only]:w-auto',
      horizontal: 'flex-row items-center gap-3 has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto',
      responsive: [
        'flex-col *:w-full [&>.sr-only]:w-auto',
        '@field-group/field-group:flex-row @field-group/field-group:items-center @field-group/field-group:gap-6 @field-group/field-group:*:w-auto',
        '@field-group/field-group:has-[>[data-slot=field-content]]:items-start @field-group/field-group:*:data-[slot=field-label]:flex-auto',
        '@field-group/field-group:*:data-[slot=field-content]:flex-auto',
      ].join(' '),
    },
  },
  defaultVariants: {orientation: 'vertical'},
});

type FieldProps = FieldPrimitive.Root.Props & VariantProps<typeof fieldVariants>;

/** Reports the root's validity up to Field, which picks the next validation mode from it. */
function FieldRoot({rootProps, invalid, disabled, onValidity}: {rootProps: ComponentProps<'div'>; invalid: boolean; disabled: boolean; onValidity: (invalid: boolean) => void}) {
  useEffect(() => { onValidity(invalid); }, [invalid, onValidity]);
  return <FieldDisabled.Provider value={disabled}><div {...rootProps} data-status={invalid ? 'fail' : undefined}/></FieldDisabled.Provider>;
}

/**
 * One label, one control, an optional description and error. Validation follows Base UI (`invalid` for
 * state you control, `validate` for your own check, or the control's native constraints), with Quartz's
 * timing: checked on blur, then on every change while it is invalid. Pass `validationMode` to override.
 */
function Field({className, orientation = 'vertical', validationMode, ...props}: FieldProps) {
  const [invalid, setInvalid] = useState(false);
  const nested = useContext(InField);
  useEffect(() => {
    if (nested && import.meta.env.DEV) console.warn('Quartz Field: a Field inside a Field binds its control to the outer label. Use FieldSet to group fields.');
  }, [nested]);
  return <InField.Provider value>
    <FieldPrimitive.Root
      data-slot="field"
      data-orientation={orientation}
      validationMode={validationMode ?? (invalid ? 'onChange' : 'onBlur')}
      className={mergeClass(fieldVariants({orientation}), className)}
      render={(rootProps, state) => <FieldRoot rootProps={rootProps as ComponentProps<'div'>} invalid={state.valid === false} disabled={!!state.disabled} onValidity={setInvalid}/>}
      {...props}
    />
  </InField.Provider>;
}

/** Stacks the label and description beside a control in a horizontal field. */
function FieldContent({className, ...props}: ComponentProps<'div'>) {
  return <div data-slot="field-content" className={cn('group/field-content flex flex-1 flex-col gap-1', className)} {...props}/>;
}

type FieldLabelProps = FieldPrimitive.Label.Props & {
  /** Adds a quiet "Optional" after the label. */
  optional?: boolean;
};

/** The field's label, bound to its control by Base UI. */
function FieldLabel({className, optional, children, ...props}: FieldLabelProps) {
  return <FieldPrimitive.Label data-slot="field-label" className={mergeClass([labelClasses, 'data-disabled:text-text-disabled'], className)} {...props}>
    {children}
    {optional && <LabelHint>Optional</LabelHint>}
  </FieldPrimitive.Label>;
}

/** A label-styled title that is not a <label>, for a field whose control names itself. */
function FieldTitle({className, ...props}: ComponentProps<'div'>) {
  return <div data-slot="field-title" className={cn('flex w-fit items-center gap-2 type-label text-text-1 group-data-disabled/field:text-text-disabled', className)} {...props}/>;
}

/** Helper text under the control, read out with it. */
function FieldDescription({className, ...props}: FieldPrimitive.Description.Props) {
  const inField = useContext(InField);
  const base = [
    'max-w-(--measure-hint) type-body-sm text-text-2 [overflow-wrap:anywhere] group-data-disabled/field:text-text-3 [[data-slot=field-legend]+&]:-mt-4',
    '[&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4 [&_code]:type-code-sm',
  ];
  if (!inField) {
    const {render: _render, className: _className, ...rest} = props as FieldPrimitive.Description.Props;
    // Outside a Field there is no Base UI state to hand a className function, so only a string applies.
    return <p data-slot="field-description" className={cn(base, typeof className === 'string' && className)} {...(rest as ComponentProps<'p'>)}/>;
  }
  return <FieldPrimitive.Description data-slot="field-description" className={mergeClass(base, className)} {...props}/>;
}

/** A hairline between groups of fields, with optional words in the middle ("or"). */
function FieldSeparator({children, className, ...props}: ComponentProps<'div'> & {children?: ReactNode}) {
  return <div data-slot="field-separator" data-content={!!children} className={cn('relative flex h-5 items-center', className)} {...props}>
    <div aria-hidden className="h-px w-full bg-line-row"/>
    {children && <span data-slot="field-separator-content" className="absolute start-1/2 -translate-x-1/2 bg-page px-2 type-body-sm text-text-3 rtl:translate-x-1/2">{children}</span>}
  </div>;
}

type FieldErrorProps = FieldPrimitive.Error.Props & {
  /** Errors from your own validation or a schema. Duplicates are dropped; two or more become a list. */
  errors?: Array<{message?: string} | undefined>;
};

/**
 * The error under the control. With `errors` or children it always shows; with neither, Base UI shows
 * the control's own validation message once the field is invalid. In the fail text colour.
 */
function FieldError({className, children, errors, match, ...props}: FieldErrorProps) {
  const unique = errors ? [...new Map(errors.filter(e => e?.message).map(e => [e!.message, e!])).values()] : [];
  const content = children ?? (unique.length === 1 ? unique[0]?.message : unique.length > 1
    ? <ul className="flex flex-col gap-1">{unique.map(e => <li key={e.message}>{e.message}</li>)}</ul>
    : undefined);
  const always = content !== undefined;
  const inField = useContext(InField);
  if (errors && !unique.length && children === undefined) return null;
  const base = 'flex min-w-0 items-start gap-2 type-body-sm text-fail-text [overflow-wrap:anywhere]';
  if (!inField) {
    if (!always) return null;
    const {render: _render, ...rest} = props;
    return <div data-slot="field-error" data-status="fail" role="alert" className={cn(base, typeof className === 'string' && className)} {...(rest as ComponentProps<'div'>)}>{content}</div>;
  }

  return <FieldPrimitive.Error
    data-slot="field-error"
    data-status="fail"
    match={match ?? (always ? true : undefined)}
    className={mergeClass(base, className)}
    {...props}
    {...(always ? {children: content} : {})}
  />;
}

// ---------- Form (was its own component) ----------

type FormProps = FormPrimitive.Props & {
  /**
   * Waiting on the submit. Sets aria-busy and drops further submits, including Enter in a text field, so a
   * request never goes out twice (trap/submit-repeat). Pass the same flag to the submit Button's pending.
   */
  pending?: boolean;
};

/**
 * A form that collects Field values, validates them on submit, focuses the first invalid field, and routes
 * server errors back to fields by name through `errors`.
 */
function Form({className, pending, onSubmit, onFormSubmit, ...props}: FormProps) {
  return <FormPrimitive
    data-slot="form"
    aria-busy={pending || undefined}
    data-pending={pending || undefined}
    onSubmit={e => {
      if (pending) { e.preventDefault(); return; }
      onSubmit?.(e);
    }}
    onFormSubmit={onFormSubmit && ((values, details) => { if (!pending) onFormSubmit(values, details); })}
    className={mergeClass('flex w-full min-w-0 flex-col gap-6', className)}
    {...props}
  />;
}

/** The row of buttons at the end of a form. Primary last, so it sits under the reading hand. */
function FormActions({className, ...props}: ComponentProps<'div'>) {
  return <div data-slot="form-actions" className={cn('flex flex-wrap items-center gap-2', className)} {...props}/>;
}

type FormStatusProps = ComponentProps<'p'> & {
  /** fail: the fail text colour. Leave unset for a neutral note (ok reads the same). */
  status?: 'ok' | 'fail';
  /** @deprecated Use status. */
  tone?: 'ok' | 'fail';
};

/** Where the result of a submit is announced. Always rendered, so screen readers hear changes. */
function FormStatus({className, status: statusProp, tone, children, ...props}: FormStatusProps) {
  const status = statusProp ?? tone;
  return <p
    data-slot="form-status"
    role="status"
    data-status={status === 'fail' ? 'fail' : undefined}
    className={cn(
      'flex min-h-5 items-start gap-2 type-body-sm text-text-1',
      status === 'fail' && 'text-fail-text',
      className,
    )}
    {...props}
  >{children}</p>;
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
  Form,
  FormActions,
  FormStatus,
  Label,
  LabelHint,
  fieldBoxVariants,
  fieldControlVariants,
  labelClasses,
  useFieldDisabled,
  type ControlSize,
  type FieldProps,
  type FormProps,
  type LabelProps,
};
