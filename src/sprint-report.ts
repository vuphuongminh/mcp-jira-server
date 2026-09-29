import axios from 'axios';
import { JiraClient, JiraIssue } from './jira-client.js';

const baseUrl = process.env.JIRA_BASE_URL;
const personalAccessToken = process.env.JIRA_PAT;
const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK;
const projectKey = process.env.JIRA_PROJECT_KEY ?? 'SAYDI';

const missingSecrets = [
  ['JIRA_BASE_URL', baseUrl],
  ['JIRA_PAT', personalAccessToken],
  ['GOOGLE_CHAT_WEBHOOK', webhookUrl],
].filter(([, value]) => !value).map(([name]) => name);

if (missingSecrets.length > 0) {
  throw new Error(`Missing required environment variables: ${missingSecrets.join(', ')}.`);
}

const configuredBaseUrl = baseUrl!;
const configuredPersonalAccessToken = personalAccessToken!;
const configuredWebhookUrl = webhookUrl!;

const jira = new JiraClient({
  baseUrl: configuredBaseUrl,
  personalAccessToken: configuredPersonalAccessToken,
  userAgent: process.env.JIRA_USER_AGENT,
});

function assigneeName(issue: JiraIssue): string {
  return issue.fields.assignee?.displayName ?? 'Unassigned';
}

function increment(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function rankedLines(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `• ${name}: ${count}`)
    .join('\n') || '• None';
}

function issueLines(issues: JiraIssue[]): string {
  return issues
    .map(issue => `• ${issue.key} — ${issue.fields.summary} (${assigneeName(issue)})`)
    .join('\n') || '• None';
}

function productionReleaseLines(issues: JiraIssue[], limit: number = 5): string {
  const newestFirst = [...issues].sort(
    (left, right) => Date.parse(right.fields.updated) - Date.parse(left.fields.updated),
  );
  const displayedIssues = newestFirst.slice(0, limit);
  const remainingCount = newestFirst.length - displayedIssues.length;
  const remainingLine = remainingCount > 0 ? `\n• +${remainingCount} other tickets` : '';
  return issueLines(displayedIssues) + remainingLine;
}

function isDone(issue: JiraIssue): boolean {
  return issue.fields.status.name.toLowerCase().startsWith('done');
}

function isCanceled(issue: JiraIssue): boolean {
  return issue.fields.status.name.toLowerCase() === 'canceled';
}

async function main(): Promise<void> {
  const jql = `project = ${projectKey} AND sprint in openSprints() ORDER BY key ASC`;
  const issues = await jira.searchAllIssues(jql);
  const bugs = issues.filter(issue => issue.fields.issuetype.name.toLowerCase() === 'bug');
  const completed = issues.filter(isDone);
  const deployedToProduction = issues.filter(
    issue => issue.fields.status.name.toLowerCase() === 'done on production',
  );
  const activeIssues = issues.filter(issue => !isDone(issue) && !isCanceled(issue));
  const openBugs = bugs.filter(issue => !isDone(issue) && !isCanceled(issue));
  const pendingIssues = activeIssues.filter(
    issue => issue.fields.status.name.toLowerCase() === 'pending',
  );

  const openBugsByAssignee = new Map<string, number>();
  const productionByAssignee = new Map<string, number>();
  const activeWorkloadByAssignee = new Map<string, number>();
  for (const issue of openBugs) {
    increment(openBugsByAssignee, assigneeName(issue));
  }
  for (const issue of deployedToProduction) {
    increment(productionByAssignee, assigneeName(issue));
  }
  for (const issue of activeIssues) {
    increment(activeWorkloadByAssignee, assigneeName(issue));
  }

  const report = [
    `*📊 Jira Sprint Report — ${projectKey}*`,
    `Scope: ${issues.length} issues in open sprints`,
    '',
    '*📌 Summary*',
    `• Completed: ${completed.length}`,
    `• Deployed to production: ${deployedToProduction.length}`,
    `• Open bugs: ${openBugs.length}`,
    `• Pending/blocked: ${pendingIssues.length}`,
    '',
    '*🚀 Production releases*',
    productionReleaseLines(deployedToProduction),
    '',
    '*✅ Tickets deployed to production by assignee*',
    rankedLines(productionByAssignee),
    '',
    '*📦 Active workload by assignee*',
    rankedLines(activeWorkloadByAssignee),
    '',
    '*⚠️ Needs attention*',
    `• ${pendingIssues.length} tickets are Pending — review blockers and owners.`,
    `• ${openBugs.length} open bugs remain in the sprint.`,
    '',
    '*🐛 Open bugs by assignee*',
    rankedLines(openBugsByAssignee),
  ].join('\n');

  const response = await fetch(configuredWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: report }),
  });

  if (!response.ok) {
    throw new Error(`Google Chat webhook failed: ${response.status} ${await response.text()}`);
  }

  console.log(report);
}

main().catch(error => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const responseBody = typeof error.response?.data === 'string'
      ? error.response.data
      : JSON.stringify(error.response?.data ?? 'No response body');
    console.error(`Jira request failed${status ? ` (${status})` : ''}: ${responseBody}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
