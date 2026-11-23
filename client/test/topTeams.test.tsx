import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TopTeams } from '../src/components/TopTeams';
const team = (id: number, rank: number) => ({
  teamId: id,
  teamCode: `T-${id}`,
  name: `Team ${id}`,
  projectName: 'Project',
  rank,
  score: 92,
  maximumScore: 110,
  baseAverage: 85,
  bonusAverage: 7,
});
it('adapts to one or two teams without empty positions', () => {
  const view = render(<TopTeams teams={[team(1, 1)]} />);
  expect(view.container.querySelectorAll('article')).toHaveLength(1);
  view.rerender(<TopTeams teams={[team(1, 1), team(2, 2)]} />);
  expect(view.container.querySelectorAll('article')).toHaveLength(2);
  expect(screen.queryByText('#3')).not.toBeInTheDocument();
});
it('preserves shared ranks and includes all ties at the cutoff', () => {
  const view = render(
    <TopTeams teams={[team(1, 1), team(2, 1), team(3, 3), team(4, 3), team(5, 5)]} />,
  );
  expect(screen.getAllByText('#1')).toHaveLength(2);
  expect(screen.getAllByText('#3')).toHaveLength(2);
  expect(view.container.querySelectorAll('article')).toHaveLength(4);
  expect(screen.queryByText('#2')).not.toBeInTheDocument();
});
it('shows the configured combined maximum and separate bonus', () => {
  render(<TopTeams teams={[team(1, 1)]} />);
  expect(screen.getByText('/ 110')).toBeInTheDocument();
  expect(screen.getByText('Base 85.00 · Bonus +7.00')).toBeInTheDocument();
});
