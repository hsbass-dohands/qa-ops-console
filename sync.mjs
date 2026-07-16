// QA Ops Console — data sync script
// Pulls live data from Jira, Confluence, and Slack and writes it into data.json
// so the static GitHub Pages site can render near-real-time information.
//
// Required GitHub Actions secrets (added by repo owner, never by an AI agent):
//   JIRA_EMAIL        - Atlassian account email
//   JIRA_API_TOKEN     - Atlassian API token (id.atlassian.com/manage-profile/security/api-tokens)
//   SLACK_BOT_TOKEN     - Slack bot token (xoxb-...) from a Slack app with scopes:
//                         channels:history, channels:read, groups:history, groups:read, users:read
//                         The bot must be invited into any *private* channels it should read
//                         (e.g. #기술-qa팀, #sigint, #sigvise, and any other private 기술-/기술과제- channels).
//
// Any step that is missing its secret, or that errors, is skipped gracefully —
// the site keeps showing the last known value rather than breaking.

import fs from 'node:fs/promises';

const JIRA_SITE = 'https://dohands.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN || '';
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';

const FUNNEL_PROJECTS = [
  { key: 'QA', name: 'QA 검증' },
  { key: 'BE', name: 'Back-end' },
  { key: 'FE', name: 'Front-end' },
  { key: 'PRODUCT', name: '제품' },
];

const SLACK_CHANNEL_PREFIXES = ['기술-', '기술과제-', 'sig'];

function jiraAuthHeader() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${token}`, Accept: 'application/json' };
}

// NOTE: Atlassian retired the classic GET /rest/api/3/search endpoint (it now
// returns HTTP 410 Gone). All issue search goes through the newer
// "enhanced JQL search" endpoint, which pages via nextPageToken instead of
// startAt/total, and has no built-in exact count.
async function jiraSearch(jql, fields, maxResults = 100) {
  const url = `${JIRA_SITE}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${fields.join(',')}`;
  const res = await fetch(url, { headers: jiraAuthHeader() });
  if (!res.ok) throw new Error(`Jira search failed (${res.status}): ${jql}`);
  return res.json();
}

// Exact counts are no longer returned by /search/jql, so use the dedicated
// approximate-count endpoint (POST, JSON body) instead.
async function jiraCount(jql) {
  const url = `${JIRA_SITE}/rest/api/3/search/approximate-count`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...jiraAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql }),
  });
  if (!res.ok) throw new Error(`Jira count failed (${res.status}): ${jql}`);
  const json = await res.json();
  return json.count ?? 0;
}

function priorityBucket(name) {
  if (!name) return null;
  const m = name.match(/P([0-3])/i);
  return m ? `P${m[1]}` : null;
}

function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

async function buildJiraData() {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.log('Jira secrets missing — skipping Jira sync, keeping existing data.json values.');
    return null;
  }

  const out = { site: JIRA_SITE };

  // 1) Open bugs by priority (site-wide)
  const openByPriority = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let totalOpen = 0;
  {
    const jql = `issuetype = 버그 AND statusCategory != Done ORDER BY created DESC`;
    let nextPageToken;
    const pageSize = 100;
    const MAX_PAGES = 20; // safety cap (~2000 issues) so a bad query can't loop forever
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ jql, maxResults: String(pageSize), fields: 'priority' });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      const url = `${JIRA_SITE}/rest/api/3/search/jql?${params.toString()}`;
      const res = await fetch(url, { headers: jiraAuthHeader() });
      if (!res.ok) throw new Error(`Jira open-bug search failed (${res.status})`);
      const json = await res.json();
      for (const issue of json.issues || []) {
        const bucket = priorityBucket(issue.fields?.priority?.name);
        if (bucket) openByPriority[bucket] = (openByPriority[bucket] || 0) + 1;
      }
      totalOpen += (json.issues || []).length;
      nextPageToken = json.nextPageToken;
      if (json.isLast || !nextPageToken || (json.issues || []).length === 0) break;
    }
  }
  out.open_by_priority = openByPriority;
  out.total_open = totalOpen;

  // 2) New / closed this week (site-wide, bugs)
  out.new_this_week = await jiraCount(`issuetype = 버그 AND created >= -7d`);
  out.closed_this_week = await jiraCount(`issuetype = 버그 AND statusCategory = Done AND resolutiondate >= -7d`);

  // 3) Ticket funnel by project (status category breakdown)
  const funnel = [];
  for (const proj of FUNNEL_PROJECTS) {
    try {
      const [todo, inprogress, done, total] = await Promise.all([
        jiraCount(`project = ${proj.key} AND statusCategory = "To Do"`),
        jiraCount(`project = ${proj.key} AND statusCategory = "In Progress"`),
        jiraCount(`project = ${proj.key} AND statusCategory = Done`),
        jiraCount(`project = ${proj.key}`),
      ]);
      funnel.push({
        key: proj.key,
        name: proj.name,
        todo,
        inprogress,
        inreview: 0,
        blocked: 0,
        done,
        total,
      });
    } catch (e) {
      console.log(`Funnel query failed for ${proj.key}: ${e.message}`);
    }
  }
  if (funnel.length) out.funnel = funnel;

  // 4) Weekly bug inflow by severity (last 8 weeks)
  try {
    const json = await jiraSearch(
      `issuetype = 버그 AND created >= -8w`,
      ['priority', 'created'],
      100
    );
    const weekBuckets = {};
    for (const issue of json.issues || []) {
      const wk = isoWeekKey(issue.fields.created);
      const bucket = priorityBucket(issue.fields?.priority?.name);
      if (!bucket) continue;
      weekBuckets[wk] = weekBuckets[wk] || { p0: 0, p1: 0, p2: 0, p3: 0 };
      weekBuckets[wk][bucket.toLowerCase()]++;
    }
    const weeks = Object.keys(weekBuckets).sort().slice(-8);
    out.weekly_severity = weeks.map((wk, i) => ({ week: `W${i + 1}`, ...weekBuckets[wk] }));
  } catch (e) {
    console.log(`Weekly severity query failed: ${e.message}`);
  }

  // 5) Calendar events from issues with a due date set (any project)
  try {
    const json = await jiraSearch(
      `duedate >= -7d AND duedate <= 45d ORDER BY duedate ASC`,
      ['summary', 'duedate', 'issuetype', 'priority'],
      50
    );
    out.calendar_events_live = (json.issues || []).map((issue) => ({
      date: issue.fields.duedate,
      title: issue.fields.summary,
      type: priorityBucket(issue.fields?.priority?.name) === 'P0' ? 'bug' : 'deadline',
      source: 'jira',
      key: issue.key,
    }));
  } catch (e) {
    console.log(`Calendar due-date query failed: ${e.message}`);
  }

  return out;
}

async function buildConfluenceData() {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.log('Atlassian secrets missing — skipping Confluence sync.');
    return null;
  }
  try {
    const spaceRes = await fetch(`${JIRA_SITE}/wiki/api/v2/spaces?keys=qa&limit=1`, { headers: jiraAuthHeader() });
    if (!spaceRes.ok) throw new Error(`space lookup failed (${spaceRes.status})`);
    const spaceJson = await spaceRes.json();
    const space = spaceJson.results?.[0];
    if (!space) throw new Error('QA space not found');

    const pagesRes = await fetch(
      `${JIRA_SITE}/wiki/api/v2/spaces/${space.id}/pages?limit=6&sort=-modified-date`,
      { headers: jiraAuthHeader() }
    );
    if (!pagesRes.ok) throw new Error(`pages lookup failed (${pagesRes.status})`);
    const pagesJson = await pagesRes.json();

    const docs = (pagesJson.results || []).map((p) => ({
      title: p.title,
      url: `${JIRA_SITE}/wiki${p._links?.webui || ''}`,
      updated: (p.version?.createdAt || '').slice(0, 10),
    }));
    return { space_key: 'qa', docs };
  } catch (e) {
    console.log(`Confluence sync failed: ${e.message}`);
    return null;
  }
}

async function buildSlackData() {
  if (!SLACK_TOKEN) {
    console.log('Slack secret missing — skipping Slack sync.');
    return null;
  }
  const headers = { Authorization: `Bearer ${SLACK_TOKEN}` };

  try {
    // Build a user id -> name map (best effort, ignore failures)
    const userMap = {};
    try {
      const usersRes = await fetch('https://slack.com/api/users.list?limit=200', { headers });
      const usersJson = await usersRes.json();
      for (const u of usersJson.members || []) {
        userMap[u.id] = u.real_name || u.name || u.id;
      }
    } catch {}

    // List channels (public + private the bot is a member of) and filter by prefix
    const channels = [];
    let cursor = '';
    do {
      const url = `https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await fetch(url, { headers });
      const json = await res.json();
      if (!json.ok) throw new Error(`conversations.list failed: ${json.error}`);
      for (const c of json.channels || []) {
        if (SLACK_CHANNEL_PREFIXES.some((p) => c.name.startsWith(p))) {
          channels.push({ id: c.id, name: c.name, is_private: !!c.is_private, is_member: !!c.is_member });
        }
      }
      cursor = json.response_metadata?.next_cursor || '';
    } while (cursor);

    // Pull recent messages from each matched channel; skip ones the bot can't access
    const allMessages = [];
    for (const ch of channels) {
      try {
        // Public channels: auto-join with channels:join so history reads work
        // without someone manually inviting the bot. Private channels can't be
        // auto-joined — those still need a manual /invite from a channel member.
        if (!ch.is_private && !ch.is_member) {
          const joinRes = await fetch('https://slack.com/api/conversations.join', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: ch.id }),
          });
          const joinJson = await joinRes.json();
          if (!joinJson.ok) {
            console.log(`Could not join #${ch.name}: ${joinJson.error}`);
          }
        }

        const res = await fetch(
          `https://slack.com/api/conversations.history?channel=${ch.id}&limit=5`,
          { headers }
        );
        const json = await res.json();
        if (!json.ok) {
          console.log(`Skipping #${ch.name}: ${json.error}`);
          continue;
        }
        for (const m of json.messages || []) {
          if (!m.text) continue;
          allMessages.push({
            channel: ch.name,
            user: userMap[m.user] || m.user || '알 수 없음',
            ts: m.ts,
            text: m.text.slice(0, 200),
          });
        }
      } catch (e) {
        console.log(`Skipping #${ch.name}: ${e.message}`);
      }
    }
    allMessages.sort((a, b) => Number(b.ts) - Number(a.ts));

    return { channel_prefixes: SLACK_CHANNEL_PREFIXES, channels, messages: allMessages.slice(0, 8) };
  } catch (e) {
    console.log(`Slack sync failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const dataPath = new URL('./data.json', import.meta.url);
  const current = JSON.parse(await fs.readFile(dataPath, 'utf8'));

  const [jira, confluence, slack] = await Promise.all([
    buildJiraData(),
    buildConfluenceData(),
    buildSlackData(),
  ]);

  const next = {
    ...current,
    generated_at: new Date().toISOString(),
    source: 'live-sync',
    jira: jira ? { ...current.jira, ...jira } : current.jira,
    confluence: confluence || current.confluence,
    slack: slack || current.slack,
  };

  await fs.writeFile(dataPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log('data.json updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
