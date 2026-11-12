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
 * Action: get-work-order
 * Reads one Jira work item and returns the fields the agent needs to review
 * the planned work. Returns an object with an "error" message instead of
 * throwing, so the agent can explain the problem to the user.
 */
export async function getWorkOrder(payload) {
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
  // agent can tell the user exactly what the work order does not state.
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

// Confluence space that holds the NISP-RP reference cards (demo data).
const REFERENCE_SPACE_KEY = 'RPREF';

/**
 * Confluence stores page bodies as HTML-like "storage format". The agent only
 * needs readable text, so this helper turns table rows into lines, table
 * cells into " | " separators, removes the remaining tags and decodes the
 * few HTML entities that appear in the cards.
 */
function storageToText(html) {
  return String(html || '')
    .replace(/<\/tr>/g, '\n')
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<\/p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Action: get-reference-cards
 * Reads the NISP-RP reference cards from Confluence and returns their text.
 * Each card lists the checks a work order should satisfy and the NISP section
 * each check comes from. An optional documentNumber (for example "003")
 * returns only the matching card.
 */
export async function getReferenceCards(payload) {
  const headers = { headers: { Accept: 'application/json' } };

  // Step 1: find the numeric id of the reference space from its key.
  const spaceResponse = await api
    .asApp()
    .requestConfluence(route`/wiki/api/v2/spaces?keys=${REFERENCE_SPACE_KEY}`, headers);
  if (!spaceResponse.ok) {
    console.error(`Confluence returned status ${spaceResponse.status} when looking up the space`);
    return { error: `Could not read the reference space (status ${spaceResponse.status}).` };
  }
  const spaces = (await spaceResponse.json()).results || [];
  if (spaces.length === 0) {
    return { error: `Reference space ${REFERENCE_SPACE_KEY} was not found.` };
  }

  // Step 2: read the pages in that space, including their body text.
  const pagesResponse = await api
    .asApp()
    .requestConfluence(
      route`/wiki/api/v2/spaces/${spaces[0].id}/pages?body-format=storage&limit=25`,
      headers
    );
  if (!pagesResponse.ok) {
    console.error(`Confluence returned status ${pagesResponse.status} when reading pages`);
    return { error: `Could not read the reference cards (status ${pagesResponse.status}).` };
  }
  const pages = (await pagesResponse.json()).results || [];

  // Keep only the NISP cards, and only the requested one if a number was given.
  const wanted = String((payload && payload.documentNumber) || '').replace(/\D/g, '');
  const cards = pages
    .filter((page) => /NISP-RP-\d+/.test(page.title))
    .filter((page) => !wanted || page.title.includes(`NISP-RP-${wanted.padStart(3, '0')}`))
    .map((page) => ({
      title: page.title,
      text: storageToText(page.body && page.body.storage ? page.body.storage.value : ''),
    }));

  if (cards.length === 0) {
    return { error: 'No NISP reference cards were found.' };
  }
  return { cards };
}
