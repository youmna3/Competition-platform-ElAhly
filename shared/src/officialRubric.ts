/**
 * The official 2026 judging rubric, from "Judging & Evaluation Criteria Rubric
 * File (1).docx". Section and criterion titles, descriptions and maximum points
 * are copied verbatim from that document (only surrounding spaces trimmed). Loading it only fills a rubric draft; an administrator
 * reviews and publishes it.
 */
import { POINTS_FORMAT, type RubricContent } from './rubric.js';

export const OFFICIAL_RUBRIC_2026_TITLE = 'Judging & Evaluation Criteria 2026';

export function officialRubric2026(): RubricContent {
  const c = (title: string, maxPoints: number, description: string) => ({
    title,
    description,
    guidelines: '',
    maxPoints,
  });
  return {
    scoringFormat: POINTS_FORMAT,
    title: OFFICIAL_RUBRIC_2026_TITLE,
    description:
      'The judging panel will score the teams out of 100 points based on the following specific criteria.',
    instructions:
      'Award each criterion a whole number of points from 0 up to its maximum. Leave a criterion blank only if you have not scored it yet; 0 is a valid score. Section scores are the sum of their criteria: A 30, B 25, C 25 and D 20 points, 100 in total.',
    sections: [
      {
        type: 'actual',
        title: 'Prompt Engineering & Logic',
        description:
          'How effectively did the team use AI to generate complex app features (e.g., databases, functional buttons):',
        weightPercent: 30,
        maxBonusPoints: null,
        criteria: [
          c(
            'Prompt clarity & structure',
            10,
            'Prompts are specific, give context and state the expected output',
          ),
          c(
            'Functional logic',
            10,
            'Buttons, forms and workflows work correctly with no broken features',
          ),
          c(
            'Debugging with AI',
            10,
            'The team found errors and fixed them by prompting effectively',
          ),
        ],
      },
      {
        type: 'actual',
        title: 'UI/UX & Design',
        description: 'Is the app visually appealing, user-friendly, and easy to navigate?',
        weightPercent: 25,
        maxBonusPoints: null,
        criteria: [
          c('Navigation & ease of use', 10, 'A new user can find everything without needing help.'),
          c(
            'Responsiveness',
            8,
            'The app looks good and works well on both a phone and a computer screen.',
          ),
          c(
            'Creative design',
            7,
            'The app has its own special look and does not look like a ready-made template.',
          ),
        ],
      },
      {
        type: 'actual',
        title: 'Problem Solving & Utility',
        description: 'Does the app solve a real-world problem effectively?',
        weightPercent: 25,
        maxBonusPoints: null,
        criteria: [
          c('Problem definition', 7, 'The real-life problem is clear and matters to people.'),
          c('Target users', 8, 'The team knows who will use the app (Audience) and why'),
          c(
            'Solution effectiveness & Idea',
            10,
            'The app actually solves the stated problem and the team can explain the idea of the app ex how could earn money (for example, subscriptions, ads or fees) and who would pay.',
          ),
        ],
      },
      {
        type: 'actual',
        title: 'Pitch & Presentation',
        description:
          "Quality of the Canva slide deck and the team's ability to confidently explain their product.",
        weightPercent: 20,
        maxBonusPoints: null,
        criteria: [
          c('Presentation quality', 8, 'Slides look neat, have little text and use good pictures.'),
          c(
            'Clear story',
            6,
            'The presentation follows a simple order: problem, solution, demo, result.',
          ),
          c('Live demo', 6, 'The team demonstrated the project live and did not just explain it'),
        ],
      },
    ],
  };
}
