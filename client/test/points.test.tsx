import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { officialRubric2026, type EvaluationInput, type RubricVersion } from '@judging/shared';
import { PointsInput } from '../src/components/PointsInput';
import { ScoringForm } from '../src/pages/judge/EvaluationPage';

function officialVersion(): RubricVersion {
  let id = 1;
  const c = officialRubric2026();
  return {
    ...c,
    id: 900,
    versionNo: 4,
    status: 'published',
    revision: 1,
    createdAt: '',
    updatedAt: '',
    updatedByEmail: null,
    publishedAt: '',
    publishedByEmail: null,
    sections: c.sections.map((s) => ({
      ...s,
      id: id++,
      criteria: s.criteria.map((cr) => ({ ...cr, id: 100 + id++ })),
    })),
  };
}

function Harness({ max = 10 }: { max?: number }) {
  const [value, setValue] = useState<number | null>(null);
  return (
    <>
      <PointsInput label="Prompt clarity" value={value} max={max} onChange={setValue} />
      <output data-testid="value">{value == null ? 'blank' : value}</output>
    </>
  );
}

describe('PointsInput', () => {
  it('accepts whole points, caps at the maximum and treats blank as not scored', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Prompt clarity (0 to 10 points)');
    expect(screen.getByTestId('value')).toHaveTextContent('blank');
    await userEvent.type(input, '7');
    expect(screen.getByTestId('value')).toHaveTextContent('7');
    await userEvent.clear(input);
    expect(screen.getByTestId('value')).toHaveTextContent('blank');
    await userEvent.type(input, '0');
    expect(screen.getByTestId('value')).toHaveTextContent('0');
    await userEvent.clear(input);
    await userEvent.type(input, '15');
    expect(screen.getByTestId('value')).toHaveTextContent('10');
    await userEvent.clear(input);
    await userEvent.type(input, '-3.5');
    expect(screen.getByTestId('value')).toHaveTextContent('10'); // non-digits are ignored: "35" → capped
  });

  it('steps with buttons and arrow keys within 0..max', async () => {
    render(<Harness max={6} />);
    const up = screen.getByRole('button', { name: 'Increase Prompt clarity' });
    const down = screen.getByRole('button', { name: 'Decrease Prompt clarity' });
    expect(down).toBeDisabled();
    await userEvent.click(up);
    expect(screen.getByTestId('value')).toHaveTextContent('0');
    await userEvent.click(up);
    await userEvent.click(up);
    expect(screen.getByTestId('value')).toHaveTextContent('2');
    const input = screen.getByLabelText('Prompt clarity (0 to 6 points)');
    input.focus();
    await userEvent.keyboard('{End}');
    expect(screen.getByTestId('value')).toHaveTextContent('6');
    expect(up).toBeDisabled();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByTestId('value')).toHaveTextContent('4');
    await userEvent.keyboard('{Home}');
    expect(screen.getByTestId('value')).toHaveTextContent('0');
  });
});

function Form() {
  const rubric = officialVersion();
  const [input, setInput] = useState<EvaluationInput>({
    ratings: rubric.sections.flatMap((s) =>
      s.criteria.map((c) => ({ criterionId: c.id, rating: null, note: '' })),
    ),
    sectionNotes: rubric.sections.map((s) => ({ sectionId: s.id, note: '' })),
    overallNotes: '',
  });
  return <ScoringForm rubric={rubric} input={input} onChange={setInput} />;
}

describe('points scoring form', () => {
  it('shows numeric inputs with maxima, live section subtotals and the total, without stars', async () => {
    render(<Form />);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    const inputs = screen.getAllByLabelText(/^Points for .* \(0 to \d+ points\)$/);
    expect(inputs).toHaveLength(12);
    expect(screen.getByLabelText('Points for Responsiveness (0 to 8 points)')).toBeInTheDocument();
    const sectionA = screen
      .getByRole('heading', { name: 'Prompt Engineering & Logic' })
      .closest('.ui-card') as HTMLElement;
    expect(within(sectionA).getByText('30 points', { exact: false })).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText('Points for Prompt clarity & structure (0 to 10 points)'),
      '8',
    );
    await userEvent.type(
      screen.getByLabelText('Points for Functional logic (0 to 10 points)'),
      '0',
    );
    expect(within(sectionA).getAllByText('8').length).toBeGreaterThan(0); // live subtotal
    expect(screen.getByText('2 of 12 criteria scored')).toBeInTheDocument();
    expect(screen.getByText('so far')).toBeInTheDocument();

    // Fill everything at the maximum: the total is exactly 100.
    for (const el of screen.getAllByLabelText(/^Points for /)) {
      el.focus();
      await userEvent.keyboard('{End}');
    }
    expect(screen.getByText('12 of 12 criteria scored')).toBeInTheDocument();
    expect(screen.getAllByText('100').length).toBeGreaterThan(0);
    expect(screen.queryByText('so far')).not.toBeInTheDocument();
  });

  it('shows read-only points as "value / max"', () => {
    const rubric = officialVersion();
    const input: EvaluationInput = {
      ratings: rubric.sections.flatMap((s) =>
        s.criteria.map((c) => ({ criterionId: c.id, rating: c.maxPoints! - 1, note: '' })),
      ),
      sectionNotes: rubric.sections.map((s) => ({ sectionId: s.id, note: '' })),
      overallNotes: '',
    };
    render(<ScoringForm rubric={rubric} input={input} readOnly />);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getAllByText('88').length).toBeGreaterThan(0); // 100 − 12
  });
});
