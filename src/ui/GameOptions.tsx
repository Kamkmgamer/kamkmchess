import { useId, useRef, useState } from 'react';
import { Button } from '../components/quartz/ui/button';
import { Field, FieldError, FieldLabel, Form, FormStatus } from '../components/quartz/ui/field';
import { InputControl, InputRoot } from '../components/quartz/ui/input/parts';
import { RadioGroup, RadioGroupOption } from '../components/quartz/ui/radio-group';
import { prepareSetup, type PreviewSetup, type SetupDraft } from './game-setup';

type GameOptionsProps = {
  draft: SetupDraft;
  onDraftChange: (draft: SetupDraft) => void;
  onApply: (setup: PreviewSetup) => void;
};

export function GameOptions({ draft, onDraftChange, onApply }: GameOptionsProps) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const { side, minutes, increment, modelId, start } = draft;
  const [feedback, setFeedback] = useState<{ kind: 'idle' } | { kind: 'error'; field: string; message: string }>({ kind: 'idle' });
  const invalid = (field: string) => feedback.kind === 'error' && feedback.field === field;

  function apply() {
    const result = prepareSetup(draft);
    if (!result.ok) {
      setFeedback({ kind: 'error', field: result.field, message: result.message });
      formRef.current?.querySelector<HTMLElement>(`[name="${result.field}"]`)?.focus();
      return;
    }
    setFeedback({ kind: 'idle' });
    onApply(result.setup);
  }

  return (
    <Form className="game-options-form" ref={formRef} pending={false} onSubmit={(event) => event.preventDefault()} onFormSubmit={apply}>
      <div className="options-introduction">
        <h2>Game options</h2>
      </div>

      <Field name="modelId">
        <FieldLabel htmlFor={`${id}-model`}>Model ID <span className="optional-label">(optional)</span></FieldLabel>
        <InputRoot size="lg" invalid={invalid('modelId')}>
          <InputControl id={`${id}-model`} name="modelId" value={modelId} onValueChange={(value) => onDraftChange({ ...draft, modelId: value })} placeholder="Your model’s exact ID" autoComplete="off" aria-invalid={invalid('modelId') || undefined} aria-describedby={`${id}-status`} />
        </InputRoot>
        <FieldError />
      </Field>

      <div className="options-field">
        <p id={`${id}-side`}>Your side</p>
        <RadioGroup className="side-choices" aria-labelledby={`${id}-side`} value={side} onValueChange={(value) => { if (value === 'white' || value === 'black' || value === 'random') onDraftChange({ ...draft, side: value }); }}>
          <RadioGroupOption value="white" label="White" />
          <RadioGroupOption value="black" label="Black" />
          <RadioGroupOption value="random" label="Random" />
        </RadioGroup>
      </div>

      <div className="time-options">
        <Field name="minutes">
          <FieldLabel htmlFor={`${id}-minutes`}>Minutes</FieldLabel>
          <InputRoot size="lg" invalid={invalid('minutes')}>
            <InputControl id={`${id}-minutes`} name="minutes" type="number" min="0" step="any" required value={minutes} onValueChange={(value) => onDraftChange({ ...draft, minutes: value })} aria-invalid={invalid('minutes') || undefined} aria-describedby={`${id}-status`} />
          </InputRoot>
          <FieldError />
        </Field>
        <Field name="increment">
          <FieldLabel htmlFor={`${id}-increment`}>Increment (sec)</FieldLabel>
          <InputRoot size="lg" invalid={invalid('increment')}>
            <InputControl id={`${id}-increment`} name="increment" type="number" min="0" step="any" required value={increment} onValueChange={(value) => onDraftChange({ ...draft, increment: value })} aria-invalid={invalid('increment') || undefined} aria-describedby={`${id}-status`} />
          </InputRoot>
          <FieldError />
        </Field>
      </div>

      <div className="options-field">
        <p id={`${id}-position`}>Starting position</p>
        <RadioGroup aria-labelledby={`${id}-position`} value={start.kind} onValueChange={(value) => { if (value === 'standard' || value === 'custom') onDraftChange({ ...draft, start: value === 'standard' ? { kind: 'standard' } : { kind: 'custom', fen: '' } }); }}>
          <RadioGroupOption value="standard" label="Standard board" />
          <RadioGroupOption value="custom" label="Custom FEN" />
        </RadioGroup>
      </div>

      {start.kind === 'custom' && (
        <Field name="fen">
          <FieldLabel htmlFor={`${id}-fen`}>Position FEN</FieldLabel>
          <InputRoot size="lg" invalid={invalid('fen')}>
            <InputControl id={`${id}-fen`} name="fen" required value={start.fen} onValueChange={(value) => onDraftChange({ ...draft, start: { kind: 'custom', fen: value } })} placeholder="Paste all six FEN fields" autoComplete="off" spellCheck={false} aria-invalid={invalid('fen') || undefined} aria-describedby={`${id}-status`} />
          </InputRoot>
          <FieldError />
        </Field>
      )}

      <FormStatus id={`${id}-status`} {...(feedback.kind === 'error' ? { status: 'fail' } : {})}>
        {feedback.kind === 'error' ? feedback.message : 'Setup preview only. No AI requests are sent.'}
      </FormStatus>
      <Button variant="secondary" size="lg" type="submit" pending={false}>Update board preview</Button>
    </Form>
  );
}
