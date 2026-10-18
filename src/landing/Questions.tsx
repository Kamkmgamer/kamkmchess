import { Accordion } from '@base-ui/react/accordion';
import { Add, Icon, Subtract } from '../components/quartz/icon';

const questions = [
  {
    id: 'availability',
    question: 'Can I play a full game yet?',
    answer: 'Yes. Open Play against AI from the sidebar to start a match. The board here is an opening preview.',
  },
  {
    id: 'engine',
    question: 'Is this a traditional chess engine?',
    answer: 'A language model chooses its own moves. You can also choose a browser engine in the game setup.',
  },
  {
    id: 'models',
    question: 'Which model can I play against?',
    answer: 'Connect your provider or proxy in the game, then choose an available model from its list.',
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
