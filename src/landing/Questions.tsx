import { Accordion } from '@base-ui/react/accordion';
import { Add, Icon, Subtract } from '../components/quartz/icon';

const questions = [
  {
    id: 'availability',
    question: 'Can I play a full game yet?',
    answer: 'Not yet. You can explore the opening preview while we build the full match experience.',
  },
  {
    id: 'engine',
    question: 'Is this a traditional chess engine?',
    answer: 'No. A language model will choose the moves. The chess rules still apply, but the opponent is a different kind of program.',
  },
  {
    id: 'models',
    question: 'Which model can I play against?',
    answer: 'The plan is to use the models available through your own provider or connected proxy. Model availability will depend on your connection.',
  },
];

/** Base UI Accordion, discovered through Col; at most one answer is open. */
export function Questions() {
  return (
    <section id="questions" className="questions-section page-width" aria-labelledby="questions-heading">
      <h2 id="questions-heading">Before you play</h2>
      <Accordion.Root className="questions-list" defaultValue={['availability']} data-ui>
        {questions.map(({ id, question, answer }) => (
          <Accordion.Item className="question" value={id} key={id}>
            <Accordion.Header className="question-header">
              <Accordion.Trigger className="question-trigger">
                <span className="question-label">{question}</span>
                <span className="question-indicator" aria-hidden="true">
                  <Icon className="question-expand" icon={Add} size={24} />
                  <Icon className="question-collapse" icon={Subtract} size={24} />
                </span>
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Panel className="question-answer">
              <p>{answer}</p>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion.Root>
    </section>
  );
}
