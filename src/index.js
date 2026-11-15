// Rad Work Order Reviewer - backend functions for the Rovo agent actions.
// Each exported function is wired to an action in manifest.yml.

import api, { route } from '@forge/api';
import { reviewWorkOrder } from './engine.js';

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
  // Normalise the key the agent passed in, e.g. " wo-12 " -> "WO-12".
  const issueKey = String((payload && payload.issueKey) || '').trim().toUpperCase();

  // Reject anything that does not look like a Jira key before calling the API.
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
    return { error: 'That does not look like a work item key. Expected a format like WO-12.' };
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
 * Reads every NISP-RP reference card page from the Confluence reference space.
 * Returns { pages } on success or { error } with a message the agent can
 * relay. Shared by the two actions below so they always see the same cards.
 */
async function loadCardPages() {
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

  // Step 2: read the pages in that space, including their body.
  const pagesResponse = await api
    .asApp()
    .requestConfluence(
      route`/wiki/api/v2/spaces/${spaces[0].id}/pages?body-format=storage&limit=50`,
      headers
    );
  if (!pagesResponse.ok) {
    console.error(`Confluence returned status ${pagesResponse.status} when reading pages`);
    return { error: `Could not read the reference cards (status ${pagesResponse.status}).` };
  }
  const results = (await pagesResponse.json()).results || [];

  // Keep only the NISP cards and work out each card's review status.
  const pages = results
    .filter((page) => /NISP-RP-\d+/.test(page.title))
    .map((page) => {
      const html = page.body && page.body.storage ? page.body.storage.value : '';
      return {
        title: page.title,
        html,
        status: /Card status:\s*REVIEWED/.test(storageToText(html)) ? 'REVIEWED' : 'DRAFT',
      };
    });
  return { pages };
}

/**
 * Action: get-reference-cards
 * Returns the text of the NISP-RP reference cards. Each card lists the checks
 * a Work Order should satisfy and the NISP section each check comes from.
 * Draft cards are left out unless includeDrafts is "yes". An optional
 * documentNumber (for example "003") returns only the matching card.
 */
export async function getReferenceCards(payload) {
  const loaded = await loadCardPages();
  if (loaded.error) {
    return loaded;
  }

  const wanted = String((payload && payload.documentNumber) || '').replace(/\D/g, '');
  const includeDrafts = /^(yes|true)$/i.test(String((payload && payload.includeDrafts) || '').trim());

  const cards = loaded.pages
    .filter((page) => !wanted || page.title.includes(`NISP-RP-${wanted.padStart(3, '0')}`))
    .filter((page) => includeDrafts || page.status === 'REVIEWED')
    .map((page) => ({ title: page.title, status: page.status, text: storageToText(page.html) }));

  if (cards.length === 0) {
    return { error: 'No NISP reference cards were found.' };
  }
  return { cards };
}

/**
 * Action: list-capabilities
 * Tells the agent exactly what it can and cannot do, built from the cards
 * that exist right now. The agent must describe itself only from this list,
 * so it never promises a check that no reviewed card supports.
 */
export async function listCapabilities() {
  const loaded = await loadCardPages();
  if (loaded.error) {
    return loaded;
  }

  // The first cell of each table row is the name of a check. The header row
  // uses <th>, so it is skipped automatically.
  const checkNames = (html) =>
    (html.match(/<tr[^>]*>\s*<td[^>]*>(.*?)<\/td>/g) || [])
      .map((row) => storageToText(row).replace(/\s*\|\s*$/, '').trim())
      .filter(Boolean);

  const describe = (page) => ({ card: page.title, checks: checkNames(page.html) });

  return {
    canDo: [
      'Read one Jira Work Order by its key.',
      'Compare that Work Order with the reviewed reference cards listed below.',
      'Report conflicts, missing items, covered items and reminders, with the NISP section for each.',
      'Answer a narrow question about one Work Order using the same cards.',
      'Include draft cards when the person explicitly asks, marked as not yet reviewed.',
    ],
    cannotDo: [
      'Approve, reject or authorize work.',
      'Create, edit or comment on a Work Order or a Rad Work Permit.',
      'Check anything that is not in a reference card.',
      'Read documents outside the reference cards and the Work Order.',
    ],
    reviewedCards: loaded.pages.filter((page) => page.status === 'REVIEWED').map(describe),
    draftCards: loaded.pages.filter((page) => page.status === 'DRAFT').map((page) => page.title),
  };
}

/**
 * Action: review-work-order
 * The full review. Reads the Work Order, checks which reference cards are
 * REVIEWED, and runs the rules engine in src/engine.js. Every finding, number
 * and section in the result is computed by code; the agent only presents it.
 */
export async function reviewWorkOrderAction(payload) {
  const workOrder = await getWorkOrder(payload);
  if (workOrder.error) {
    return workOrder;
  }

  // Only cards marked REVIEWED in Confluence are applied.
  const loaded = await loadCardPages();
  if (loaded.error) {
    return loaded;
  }
  const reviewed = loaded.pages
    .filter((page) => page.status === 'REVIEWED')
    .map((page) => (page.title.match(/NISP-RP-(\d{3})/) || [])[1])
    .filter(Boolean);

  const result = reviewWorkOrder(workOrder.description || '', reviewed);
  return {
    key: workOrder.key,
    summary: workOrder.summary,
    ...result,
  };
}
