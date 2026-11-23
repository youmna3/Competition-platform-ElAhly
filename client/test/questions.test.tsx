import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { defaultRubricContent } from '@judging/shared';
import { RubricEditor } from '../src/pages/admin/rubric/RubricEditor';
import { toEdit, toContent } from '../src/pages/admin/rubric/model';
function Editor() {
  const r = defaultRubricContent();
  r.scoringFormat = 3;
  r.sections = r.sections.slice(0, 1);
  r.sections[0]!.weightPercent = 100;
  r.sections[0]!.criteria[0]!.title = 'First';
  r.sections[0]!.criteria[1]!.title = 'Second';
  const [value, set] = useState(() => toEdit(r));
  return (
    <RubricEditor value={value} onChange={set} content={toContent(value)} errors={new Map()} />
  );
}
it('adds and removes questions, keeps a minimum of one and recalculates equal contributions', async () => {
  render(<Editor />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Add Question' }));
  expect(screen.getAllByLabelText('Criterion title')).toHaveLength(3);
  expect(screen.getAllByText('Maximum contribution: 33.33 points (equal share)')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Remove question 1.3' }));
  await user.click(screen.getByRole('button', { name: 'Remove question 1.2' }));
  expect(screen.getByRole('button', { name: 'Remove question 1.1' })).toBeDisabled();
});
it('reorders question content with its stable row key', async () => {
  render(<Editor />);
  await userEvent.click(screen.getByRole('button', { name: 'Move question 1.2 up' }));
  const titles = screen.getAllByLabelText('Criterion title');
  expect(titles[0]).toHaveValue('Second');
  expect(titles[1]).toHaveValue('First');
});
