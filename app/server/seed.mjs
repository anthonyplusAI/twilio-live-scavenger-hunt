import { readFileSync } from 'node:fs';

const categoryByPrefix = {
  C: 'Color', O: 'Object', G: 'Gesture', S: 'Shape', T: 'Text',
  N: 'Count', M: 'Combination', V: 'Creative',
};
const activePilotIds = new Set(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'O01', 'T01', 'G02', 'M01']);

export function promptBank() {
  let markdown = '';
  try { markdown = readFileSync(new URL('../../docs/concepts/find-it-first-challenge-library.md', import.meta.url), 'utf8'); }
  catch { /* Packaged apps can supply their own event prompt packs. */ }
  const prompts = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\|\s*([COGSTNMV]\d{2})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/);
    if (!match) continue;
    const [, id, text, tier, , caution] = match;
    const category = categoryByPrefix[id[0]];
    prompts.push({
      id, text: text.trim(), category, tier: tier.trim(),
      judgeMode: 'ai-assisted', detector: `visual:${text.trim()}`,
      priority: category === 'Color' ? 'low' : 'standard',
      enabled: activePilotIds.has(id), seconds: category === 'Creative' ? 60 : null,
      accessNote: caution.trim(),
    });
  }
  if (prompts.length === 50) return prompts;
  return [
    { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', tier: 'Launch candidate', judgeMode: 'ai-assisted', detector: 'visual:SHOW SOMETHING RED', priority: 'low', enabled: true, seconds: null, accessNote: 'Provide a red card.' },
    { id: 'O01', text: 'SHOW A CUP', category: 'Object', tier: 'Launch candidate', judgeMode: 'ai-assisted', detector: 'visual:SHOW A CUP', priority: 'standard', enabled: true, seconds: null, accessNote: 'Supply an empty cup.' },
    { id: 'T01', text: 'FIND THE WORD TWILIO', category: 'Text', tier: 'Pilot', judgeMode: 'ai-assisted', detector: 'visual:FIND THE WORD TWILIO', priority: 'standard', enabled: true, seconds: null, accessNote: 'Supply a printed card.' },
  ];
}
