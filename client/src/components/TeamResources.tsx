import type { TeamResources as Resources } from '@judging/shared';

function safeLink(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}
export function TeamResources({ team }: { team: Resources }) {
  const presentation = safeLink(team.presentationLink),
    website = safeLink(team.projectWebsiteLink);
  return (
    <div className="space-y-3 text-sm">
      <div>
        <h3 className="font-semibold">Students</h3>
        {team.studentNames?.length ? (
          <ul className="mt-1 list-inside list-disc text-muted">
            {team.studentNames.map((name, i) => (
              <li key={i}>{name}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-muted">Student details have not been provided.</p>
        )}
      </div>
      {(presentation || website) && (
        <div className="flex flex-wrap gap-3">
          {presentation && (
            <a
              className="secondary-link"
              href={presentation}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Presentation
            </a>
          )}
          {website && (
            <a className="secondary-link" href={website} target="_blank" rel="noopener noreferrer">
              Open Project Website
            </a>
          )}
        </div>
      )}
    </div>
  );
}
