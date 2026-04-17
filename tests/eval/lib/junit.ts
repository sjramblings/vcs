import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { jUnit } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

export function junitSummary(data: any, suiteName: string, category: 'functional' | 'performance') {
  return {
    [`/tmp/test-results/${category}/${suiteName}.xml`]: jUnit(data),
    stdout: textSummary(data, { indent: '  ', enableColors: false }),
  };
}
