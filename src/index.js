// Work Permit Copilot - backend functions for the Rovo agent actions.
// Each exported function is wired to an action in manifest.yml.

import api, { route } from '@forge/api';

/**
 * Jira stores rich text (like the description) in a JSON format called
 * Atlassian Document Format (ADF). The agent only needs plain text, so this
 * helper walks the ADF tree and joins every piece of text it finds.
 */
function adfToText(node) {
  if (!node) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (node.type === 'text') {
    return node.text || '';
  }
  const children = Array.isArray(node.content) ? node.content : [];
  const text = children.map(adfToText).join('');
  // Block-level nodes end with a line break so paragraphs and list items
  // do not run together.
  const blockTypes = ['paragraph', 'heading', 'listItem', 'tableRow', 'codeBlock'];
  return blockTypes.includes(node.type) ? `${text}\n` : text;
}

/**
 * Action: get-work-ticket
 * Reads one Jira work item and returns the fields the agent needs to review
 * the planned work. Returns an object with an "error" message instead of
 * throwing, so the agent can explain the problem to the user.
 */
export async function getWorkTicket(payload) {
  // Normalise the key the agent passed in, e.g. " ops-12 " -> "OPS-12".
  const issueKey = String((payload && payload.issueKey) || '').trim().toUpperCase();

  // Reject anything that does not look like a Jira key before calling the API.
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
    return { error: 'That does not look like a work item key. Expected a format like OPS-12.' };
  }

  // Ask Jira only for the fields we use. The route helper escapes the key.
  const response = await api
    .asApp()
    .requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,description,status,labels,priority,assignee,issuetype`,
      { headers: { Accept: 'application/json' } }
    );

  if (response.status === 404) {
    return { error: `Work item ${issueKey} was not found, or the app cannot see it.` };
  }
  if (!response.ok) {
    console.error(`Jira returned status ${response.status} for ${issueKey}`);
    return { error: `Jira returned an error (status ${response.status}) for ${issueKey}.` };
  }

  const issue = await response.json();
  const fields = issue.fields || {};

  // Return a small, flat object. Empty values are reported as null so the
  // agent can tell the user exactly what the ticket does not state.
  return {
    key: issue.key,
    type: fields.issuetype ? fields.issuetype.name : null,
    summary: fields.summary || null,
    description: adfToText(fields.description).trim() || null,
    status: fields.status ? fields.status.name : null,
    priority: fields.priority ? fields.priority.name : null,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    assignee: fields.assignee ? fields.assignee.displayName : null,
  };
}
