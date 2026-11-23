import { useQuery } from '@tanstack/react-query';
import { COMPETITION_LABELS, type CompetitionStatus } from '@judging/shared';
import { api } from '../api/client';
import { Alert } from './ui';

export function useCompetition(enabled = true) {
  return useQuery({
    queryKey: ['competition'],
    queryFn: () => api<CompetitionStatus>('/api/competition'),
    enabled,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
export function CompetitionNotice() {
  const { data } = useCompetition();
  if (!data) return null;
  return (
    <div className="mb-6">
      <Alert tone="info" title={`Competition: ${COMPETITION_LABELS[data.state]}`}>
        {data.state === 'preparation'
          ? 'Teams, assignments and rubric are being prepared. Judging is not yet available.'
          : data.state === 'closed'
            ? 'Final results are read-only. Judging, corrections and reopening are disabled.'
            : `Judging is open using locked rubric v${data.lockedRubricVersionNo}.`}
      </Alert>
    </div>
  );
}
